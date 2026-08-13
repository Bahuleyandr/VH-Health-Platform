import { createHash } from 'node:crypto';

import { setTenantTx } from '../../lib/prisma.js';
import { AppError } from '../../utils/AppError.js';
import { recordCanonicalClinicalEvent } from '../clinical/canonicalClinicalPlatformService.js';

const SUPPORTED_MESSAGE_TYPES = new Set(['ADT^A01', 'ADT^A02', 'ADT^A03', 'ORM^O01']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanRequired(value, label, maxLength) {
  const normalized = String(value || '').trim();
  const containsControlCharacter = [...normalized].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 31 || (codePoint >= 127 && codePoint <= 159);
  });
  if (!normalized || normalized.length > maxLength || containsControlCharacter) {
    throw AppError.badRequest(`${label} is missing or invalid`, 'HL7_CLINICAL_IDENTITY_INVALID');
  }
  return normalized;
}

function uuidOrNull(value) {
  const component = String(value || '').split('^', 1)[0].trim().toLowerCase();
  return UUID_RE.test(component) ? component : null;
}

function messageFingerprint(message) {
  return createHash('sha256').update(String(message), 'utf8').digest('hex');
}

function receiptIdentityHash({ tenantId, senderIdentity, messageControlId }) {
  return createHash('sha256')
    .update(`${tenantId}\n${senderIdentity}\n${messageControlId}`, 'utf8')
    .digest('hex');
}

function eventContract(messageType, detail) {
  if (messageType === 'ADT^A01') {
    return {
      eventType: 'admission.created',
      eventStatus: detail.status,
      summary: 'Patient admitted from an authenticated HL7 ADT message',
      payload: {
        admission_id: detail.id,
        status: detail.status,
        ward: detail.ward,
        bed_number: detail.bed_number,
        source: 'hl7v2',
      },
    };
  }
  if (messageType === 'ADT^A02') {
    return {
      eventType: 'bed.transferred',
      eventStatus: detail.status,
      summary: 'Patient location updated from an authenticated HL7 ADT message',
      payload: {
        admission_id: detail.id,
        status: detail.status,
        ward: detail.ward,
        bed_number: detail.bed_number,
        source: 'hl7v2',
      },
    };
  }
  if (messageType === 'ADT^A03') {
    return {
      eventType: 'discharge.completed',
      eventStatus: detail.status,
      summary: 'Patient discharged from an authenticated HL7 ADT message',
      payload: {
        admission_id: detail.id,
        status: detail.status,
        discharged_at: detail.discharged_at,
        source: 'hl7v2',
      },
    };
  }
  return {
    eventType: 'investigation.ordered',
    eventStatus: detail.status,
    summary: `Investigation ordered from an authenticated HL7 ORM message: ${detail.test_name}`,
    payload: {
      investigation_id: detail.id,
      status: detail.status,
      test_name: detail.test_name,
      source: 'hl7v2',
    },
  };
}

async function findReceipt(tx, { tenantId, senderIdentity, messageControlId }) {
  const rows = await tx.$queryRawUnsafe(
    `SELECT id::text, tenant_id::text, sender_identity, message_control_id,
            message_type, payload_sha256, patient_uid::text, detail_table,
            detail_id, timeline_event_id::text, audit_event_id::text,
            acknowledgement_code, acknowledgement_text, recorded_at
       FROM hl7_inbound_clinical_receipts
      WHERE tenant_id = $1::uuid
        AND sender_identity = $2
        AND message_control_id = $3
      LIMIT 1`,
    tenantId,
    senderIdentity,
    messageControlId,
  );
  return rows[0] || null;
}

function assertExactReceipt(receipt, { messageType, payloadSha256, patientUid }) {
  if (
    receipt.message_type !== messageType
    || receipt.payload_sha256 !== payloadSha256
    || String(receipt.patient_uid).toLowerCase() !== patientUid
  ) {
    throw AppError.conflict(
      'HL7 sender and message-control identity was already used for different content',
      'HL7_CLINICAL_RECEIPT_IDENTITY_DRIFT',
    );
  }
}

async function mutateAdt(tx, { messageType, tenantId, patientUid, admission }) {
  if (messageType === 'ADT^A01') {
    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO admissions
         (patient_uid, status, ward, bed_number, admitting_doctor,
          admitted_at, reason, tenant_id, created_at, updated_at)
       VALUES ($1::uuid, 'ADMITTED', $2, $3, $4::uuid,
               $5::timestamptz, NULL, $6::uuid, NOW(), NOW())
       RETURNING id, patient_uid::text, status, ward, bed_number,
                 admitted_at, discharged_at`,
      patientUid,
      admission.ward || null,
      admission.bed_number || null,
      uuidOrNull(admission.admitting_doctor),
      admission.admitted_at || new Date().toISOString(),
      tenantId,
    );
    return rows[0];
  }

  const rows = await tx.$queryRawUnsafe(
    `WITH current_admission AS (
       SELECT id
         FROM admissions
        WHERE tenant_id = $1::uuid
          AND patient_uid = $2::uuid
          AND LOWER(status) IN ('admitted', 'transferred')
        ORDER BY admitted_at DESC NULLS LAST, id DESC
        LIMIT 1
        FOR UPDATE
     )
     UPDATE admissions AS admission_row
        SET status = $3::text,
            ward = CASE WHEN $4::text IS NULL THEN admission_row.ward ELSE $4 END,
            bed_number = CASE WHEN $5::text IS NULL THEN admission_row.bed_number ELSE $5 END,
            discharged_at = CASE
              WHEN $3::text = 'DISCHARGED' THEN $6::timestamptz
              ELSE admission_row.discharged_at
            END,
            updated_at = NOW()
       FROM current_admission
      WHERE admission_row.id = current_admission.id
      RETURNING admission_row.id, admission_row.patient_uid::text,
                admission_row.status, admission_row.ward,
                admission_row.bed_number, admission_row.admitted_at,
                admission_row.discharged_at`,
    tenantId,
    patientUid,
    messageType === 'ADT^A03' ? 'DISCHARGED' : 'TRANSFERRED',
    admission.ward || null,
    admission.bed_number || null,
    admission.discharged_at || new Date().toISOString(),
  );
  if (!rows[0]) {
    throw AppError.conflict(
      `HL7 ${messageType} requires one active admission for the patient`,
      'HL7_ACTIVE_ADMISSION_REQUIRED',
    );
  }
  return rows[0];
}

async function createInvestigation(tx, { tenantId, patientUid, patientPhone, order }) {
  const phone = String(patientPhone || '').trim();
  if (!phone) {
    throw AppError.conflict(
      'HL7 ORM requires the registered patient to have a phone number',
      'HL7_ORM_PATIENT_PHONE_REQUIRED',
    );
  }
  const rows = await tx.$queryRawUnsafe(
    `INSERT INTO investigations
       (patient_uid, phone, test_name, status, requested_at,
        tenant_id, created_at, updated_at)
     VALUES ($1::uuid, $2, $3, $4, $5::timestamp, $6::uuid, NOW(), NOW())
     RETURNING id, patient_uid::text, test_name, status, requested_at`,
    patientUid,
    phone,
    order.test_name || 'Unknown Test',
    order.status || 'PENDING',
    order.ordered_at || new Date().toISOString(),
    tenantId,
  );
  return rows[0];
}

export async function processHl7InboundClinicalMessage(input = {}) {
  const tenantId = cleanRequired(input.tenantId, 'HL7 tenant id', 36).toLowerCase();
  const patientUid = cleanRequired(input.patientUid, 'HL7 patient id', 36).toLowerCase();
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(patientUid)) {
    throw AppError.badRequest('HL7 tenant and patient identities must be UUIDs', 'HL7_CLINICAL_UUID_INVALID');
  }
  const senderIdentity = cleanRequired(input.senderIdentity, 'HL7 sender identity', 255);
  const messageControlId = cleanRequired(input.messageControlId, 'HL7 MSH-10', 199);
  const messageType = cleanRequired(input.messageType, 'HL7 message type', 20);
  if (!SUPPORTED_MESSAGE_TYPES.has(messageType)) {
    throw AppError.badRequest('Unsupported HL7 clinical message type', 'HL7_CLINICAL_TYPE_UNSUPPORTED');
  }
  const payloadSha256 = messageFingerprint(input.message);
  const identityHash = receiptIdentityHash({ tenantId, senderIdentity, messageControlId });

  return setTenantTx(tenantId, async (tx) => {
    await tx.$queryRawUnsafe(
      `SELECT pg_advisory_xact_lock(
         pg_catalog.hashtextextended($1::text, 666)
       )::text AS lock_result`,
      `${tenantId}:${senderIdentity}:${messageControlId}`,
    );

    const existing = await findReceipt(tx, { tenantId, senderIdentity, messageControlId });
    if (existing) {
      assertExactReceipt(existing, { messageType, payloadSha256, patientUid });
      return { duplicate: true, receipt: existing };
    }

    const detail = messageType.startsWith('ADT^')
      ? await mutateAdt(tx, {
        messageType,
        tenantId,
        patientUid,
        admission: input.admission || {},
      })
      : await createInvestigation(tx, {
        tenantId,
        patientUid,
        patientPhone: input.patientPhone,
        order: input.order || {},
      });
    const detailTable = messageType.startsWith('ADT^') ? 'admissions' : 'investigations';
    const canonicalContract = eventContract(messageType, detail);
    const canonical = await recordCanonicalClinicalEvent({
      tenantId,
      patientUid,
      ...canonicalContract,
      sourceTable: detailTable,
      sourceId: String(detail.id),
      resourceType: detailTable === 'admissions' ? 'admission' : 'investigation',
      resourceId: String(detail.id),
      actorRole: 'INTEGRATION_SERVICE',
      visibleToPatient: true,
      requestId: input.requestId || null,
      afterState: {
        message_type: messageType,
        detail_table: detailTable,
        detail_id: detail.id,
      },
      metadata: {
        protocol: 'HL7v2',
        sender_identity: senderIdentity,
        message_control_id: messageControlId,
        payload_sha256: payloadSha256,
      },
      timelineIdempotencyKey: `hl7-live:${identityHash}:timeline`,
      auditIdempotencyKey: `hl7-live:${identityHash}:audit`,
    }, { db: tx, strict: true });

    const rows = await tx.$queryRawUnsafe(
      `INSERT INTO hl7_inbound_clinical_receipts
         (tenant_id, sender_identity, message_control_id, message_type,
          payload_sha256, patient_uid, detail_table, detail_id,
          timeline_event_id, audit_event_id, acknowledgement_code,
          acknowledgement_text)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid, $7, $8,
               $9::uuid, $10::uuid, 'AA', 'Message accepted')
       RETURNING id::text, tenant_id::text, sender_identity, message_control_id,
                 message_type, payload_sha256, patient_uid::text, detail_table,
                 detail_id, timeline_event_id::text, audit_event_id::text,
                 acknowledgement_code, acknowledgement_text, recorded_at`,
      tenantId,
      senderIdentity,
      messageControlId,
      messageType,
      payloadSha256,
      patientUid,
      detailTable,
      detail.id,
      canonical.timeline.id,
      canonical.audit.id,
    );

    return { duplicate: false, detail, receipt: rows[0] };
  });
}

export const __testing__ = {
  messageFingerprint,
  receiptIdentityHash,
};

export default { processHl7InboundClinicalMessage };
