// src/services/clinical/documentIntegrityService.js
//
// Roadmap C4 — document integrity:
//   * e-signature records (clinical_document_signatures) with a content
//     hash of the signed row — any post-signature edit is detectable on
//     verification. Method 'electronic_attestation' today;
//     'aadhaar_esign' / 'dsc' are schema-ready for the India eSign stack
//     (gateway credentials are owner-side).
//   * audit hash-chain verification: recomputes the trigger-maintained
//     per-tenant chain on clinical_audit_events (migration 282) with the
//     SAME SQL function the trigger uses, and checks prev-hash linkage.
//
// Signing emits a canonical timeline/audit event; that audit row itself
// lands inside the hash chain, so the signature act is chained too.

import { createHash } from 'node:crypto';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from './canonicalClinicalPlatformService.js';

// Signable documents. Fixed identifiers only — never user input.
//   idType: 'int' | 'uuid' — how the table is keyed.
//   exclude: volatile columns left out of the content hash. Signed
//   documents are expected to be immutable; legitimate later changes go
//   through amendments/new versions per docs/CANONICAL_CLINICAL_TIMELINE.md.
export const SIGNABLE_DOCUMENTS = Object.freeze({
  clinical_note: {
    table: 'clinical_notes',
    idType: 'int',
    exclude: ['updated_at', 'is_signed', 'signed_at', 'signed_by'],
  },
  discharge_summary: {
    table: 'discharge_summaries',
    idType: 'int',
    exclude: ['updated_at'],
  },
  encounter: {
    table: 'patient_encounters',
    idType: 'uuid',
    // The sign transition itself mutates these; the attested content is
    // the clinical body, not the workflow stamps.
    exclude: ['updated_at', 'updated_by', 'status', 'status_history', 'signed_at', 'signed_by',
      'amended_at', 'amended_by', 'locked_at', 'locked_by', 'activated_at', 'closed_at'],
  },
  consent: {
    table: 'patient_consents',
    idType: 'int',
    exclude: ['updated_at'],
  },
  radiology_report: {
    table: 'radiology_orders',
    idType: 'int',
    exclude: ['updated_at', 'report_signed_off_at', 'report_signed_off_by'],
  },
});

/**
 * Deterministic JSON stringify (recursively sorted object keys) — the
 * canonical form both signing and verification hash. Pure — unit-tested.
 */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/** sha256 hex of the canonical form. Pure — unit-tested. */
export function contentHashOf(documentJson) {
  return createHash('sha256').update(stableStringify(documentJson), 'utf8').digest('hex');
}

async function fetchDocument(documentType, documentId) {
  const spec = SIGNABLE_DOCUMENTS[documentType];
  if (!spec) {
    throw AppError.badRequest(
      `Unknown document_type '${documentType}' — expected one of ${Object.keys(SIGNABLE_DOCUMENTS).join(', ')}`,
      'SIGN_UNKNOWN_DOCUMENT_TYPE',
    );
  }
  const idParam = spec.idType === 'uuid' ? String(documentId) : Number.parseInt(documentId, 10);
  if (spec.idType === 'int' && (!Number.isInteger(idParam) || idParam <= 0)) {
    throw AppError.badRequest('document_id must be a positive integer', 'SIGN_BAD_DOCUMENT_ID');
  }
  const excludeExpr = spec.exclude.map((c) => ` - '${c}'`).join('');
  const rows = await prisma.$queryRawUnsafe(
    `SELECT (to_jsonb(t)${excludeExpr}) AS doc,
            (to_jsonb(t) ->> 'patient_uid') AS patient_uid,
            (to_jsonb(t) ->> 'tenant_id') AS tenant_id
       FROM ${spec.table} t
      WHERE id = ${spec.idType === 'uuid' ? '$1::uuid' : '$1::int'}
      LIMIT 1`,
    idParam,
  );
  if (!rows.length) throw AppError.notFound(`${documentType} not found`, 'SIGN_DOCUMENT_NOT_FOUND');
  return { spec, row: rows[0] };
}

/**
 * Create an e-signature record over the document's current content.
 */
export async function signDocument({
  documentType, documentId, statement = null, method = 'electronic_attestation',
  esignTxnRef = null, certificateRef = null,
} = {}, context = {}) {
  if (!context.actorUid) throw AppError.unauthorized('Signer identity missing');
  if (!['electronic_attestation', 'aadhaar_esign', 'dsc'].includes(method)) {
    throw AppError.badRequest('signature_method must be electronic_attestation|aadhaar_esign|dsc', 'SIGN_BAD_METHOD');
  }
  const { spec, row } = await fetchDocument(documentType, documentId);
  const hash = contentHashOf(row.doc);

  const signature = await prisma.$transaction(async (tx) => {
    const inserted = await tx.$queryRawUnsafe(
      `INSERT INTO clinical_document_signatures
         (tenant_id, patient_uid, document_type, document_table, document_id, content_hash,
          signer_uid, signer_role, signer_name, signature_method, signature_statement,
          esign_txn_ref, certificate_ref)
       VALUES (COALESCE($1::uuid, '00000000-0000-4000-8000-000000000001'::uuid), $2::uuid, $3, $4, $5, $6,
               $7::uuid, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      row.tenant_id || null,
      row.patient_uid || null,
      documentType,
      spec.table,
      String(documentId),
      hash,
      context.actorUid,
      context.actorRole || null,
      context.actorName || null,
      method,
      statement,
      esignTxnRef,
      certificateRef,
    );
    const sig = inserted[0];

    const events = await recordCanonicalClinicalEvent({
      tenantId: sig.tenant_id,
      patientUid: sig.patient_uid,
      eventType: 'document.signed',
      eventStatus: method,
      sourceTable: 'clinical_document_signatures',
      sourceId: String(sig.id),
      resourceType: documentType,
      resourceId: String(documentId),
      actorUid: context.actorUid,
      actorRole: context.actorRole || null,
      summary: `${documentType.replace(/_/g, ' ')} signed (${method})`,
      payload: {
        signature_id: sig.id,
        document_type: documentType,
        document_table: spec.table,
        document_id: String(documentId),
        content_hash: hash,
        signature_method: method,
      },
      afterState: { content_hash: hash },
      tags: ['signature', 'integrity'],
      timelineIdempotencyKey: `clinical_document_signatures:${sig.id}:document.signed`,
      auditIdempotencyKey: `clinical_document_signatures:${sig.id}:audit:document.signed`,
    }, { db: tx });

    if (events?.audit?.id) {
      await tx.$executeRawUnsafe(
        `UPDATE clinical_document_signatures SET audit_event_id = $2::uuid WHERE id = $1::uuid`,
        sig.id, events.audit.id,
      );
      sig.audit_event_id = events.audit.id;
    }
    return sig;
  });

  logger.info('Document signed', { documentType, documentId, signature_id: signature.id, method });
  return signature;
}

/** Re-fetch the document and compare against the signed content hash. */
export async function verifyDocumentSignature(signatureId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM clinical_document_signatures WHERE id = $1::uuid LIMIT 1`,
    signatureId,
  );
  const sig = rows[0];
  if (!sig) throw AppError.notFound('Signature not found', 'SIGN_NOT_FOUND');
  let currentHash = null;
  let documentExists = true;
  try {
    const { row } = await fetchDocument(sig.document_type, sig.document_id);
    currentHash = contentHashOf(row.doc);
  } catch (err) {
    if (err?.code === 'SIGN_DOCUMENT_NOT_FOUND') documentExists = false;
    else throw err;
  }
  return {
    signature_id: sig.id,
    document_type: sig.document_type,
    document_id: sig.document_id,
    signed_at: sig.signed_at,
    signer_uid: sig.signer_uid,
    signature_method: sig.signature_method,
    signed_hash: sig.content_hash,
    current_hash: currentHash,
    document_exists: documentExists,
    intact: documentExists && currentHash === sig.content_hash,
  };
}

export async function listDocumentSignatures(documentType, documentId) {
  const spec = SIGNABLE_DOCUMENTS[documentType];
  if (!spec) {
    throw AppError.badRequest(
      `Unknown document_type '${documentType}'`,
      'SIGN_UNKNOWN_DOCUMENT_TYPE',
    );
  }
  return prisma.$queryRawUnsafe(
    `SELECT id, document_type, document_id, content_hash, signer_uid, signer_role, signer_name,
            signature_method, signature_statement, signed_at, audit_event_id
       FROM clinical_document_signatures
      WHERE document_table = $1 AND document_id = $2
      ORDER BY signed_at DESC`,
    spec.table,
    String(documentId),
  );
}

/**
 * Verify the per-tenant audit hash chain (migration 282). Recomputes every
 * row's hash with the same SQL function the trigger uses and checks
 * prev-hash linkage. `limit` verifies only the newest N links (the first
 * row of a tail window skips the linkage check — its predecessor is
 * outside the window).
 */
export async function verifyAuditChain({ tenantId = '00000000-0000-4000-8000-000000000001', limit = null } = {}) {
  const params = [tenantId];
  let windowClause = '';
  if (limit != null) {
    const parsed = Number.parseInt(limit, 10);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw AppError.badRequest('limit must be a positive integer', 'CHAIN_BAD_LIMIT');
    }
    params.push(parsed);
    windowClause = `AND chain_seq > (
      SELECT COALESCE(MAX(chain_seq), 0) - $2::int FROM clinical_audit_events WHERE tenant_id = $1::uuid
    )`;
  }
  const rows = await prisma.$queryRawUnsafe(
    `WITH chain AS (
       SELECT id, chain_seq, prev_hash, chain_hash,
              LAG(chain_hash) OVER (ORDER BY chain_seq) AS expected_prev,
              audit_chain_hash(prev_hash, id, tenant_id, action, resource_table, resource_id,
                               actor_uid, occurred_at, before_state, after_state) AS recomputed
         FROM clinical_audit_events
        WHERE tenant_id = $1::uuid AND chain_seq IS NOT NULL ${windowClause}
     ),
     verdicts AS (
       SELECT chain_seq, id,
              (recomputed = chain_hash) AS hash_ok,
              (expected_prev IS NULL OR expected_prev IS NOT DISTINCT FROM prev_hash) AS link_ok
         FROM chain
     )
     SELECT COUNT(*)::int AS checked,
            COUNT(*) FILTER (WHERE NOT hash_ok OR NOT link_ok)::int AS breaks,
            MIN(chain_seq) FILTER (WHERE NOT hash_ok OR NOT link_ok) AS first_break_seq,
            (ARRAY_AGG(id ORDER BY chain_seq) FILTER (WHERE NOT hash_ok OR NOT link_ok))[1] AS first_break_id
       FROM verdicts`,
    ...params,
  );
  const row = rows[0] || {};
  return {
    tenant_id: tenantId,
    checked: Number(row.checked) || 0,
    breaks: Number(row.breaks) || 0,
    intact: (Number(row.breaks) || 0) === 0,
    first_break_seq: row.first_break_seq != null ? Number(row.first_break_seq) : null,
    first_break_id: row.first_break_id || null,
  };
}

export default {
  SIGNABLE_DOCUMENTS,
  stableStringify,
  contentHashOf,
  signDocument,
  verifyDocumentSignature,
  listDocumentSignatures,
  verifyAuditChain,
};
