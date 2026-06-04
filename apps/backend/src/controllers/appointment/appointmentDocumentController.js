// src/controllers/appointment/appointmentDocumentController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  decideClinicalDocumentIntake,
  ingestClinicalDocumentUpload,
} from '../../services/ai/documentIntelligenceService.js';
import {
  ACCESS_POLICY_CODES,
  authorizePatientAccessRequest,
  SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
} from '../../services/security/accessDecisionService.js';
import { DEFAULT_TENANT_ID } from '../../services/tenant/tenantService.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { uploadFileToR2, getSignedFileUrl, deleteObject } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

function asJsonObject(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function buildPatientRecordExtractionSummary(row, { includeRawText = false } = {}) {
  if (!row?.ai_intake_id) return null;
  const metadata = asJsonObject(row.ai_metadata, {});
  const extractedFields = asJsonObject(row.ai_extracted_fields, {});
  const normalizedSections = asJsonObject(row.ai_normalized_sections, {});
  const safetyFlags = asJsonObject(row.ai_safety_flags, []);
  const citations = asJsonObject(row.ai_source_citations, []);

  return {
    intake_id: row.ai_intake_id,
    extraction_status: row.ai_extraction_status || 'pending',
    document_type: row.ai_document_type || row.document_type || 'other',
    reviewer_decision: row.ai_reviewer_decision || 'pending',
    reviewed_at: row.ai_reviewed_at || null,
    reviewer_note: row.ai_reviewer_note || null,
    confidence: extractedFields?.confidence ?? metadata?.confidence ?? null,
    ocr_status: metadata?.ocr_status || null,
    ocr_provider: metadata?.ocr_provider || null,
    text_char_count: metadata?.text_char_count || null,
    extracted_fields: extractedFields,
    normalized_sections: normalizedSections,
    source_citations: Array.isArray(citations) ? citations : [],
    safety_flags: Array.isArray(safetyFlags) ? safetyFlags : [],
    metadata,
    ...(includeRawText ? { raw_text: row.ai_raw_text || '' } : {}),
  };
}

function attachPatientRecordExtraction(row, options) {
  const extraction = buildPatientRecordExtractionSummary(row, options);
  return extraction ? { ...row, ai_extraction: extraction } : row;
}

function extractionUnavailable(reason, err = null) {
  return {
    intake_id: null,
    extraction_status: 'unavailable',
    reviewer_decision: 'pending',
    reason,
    message: err?.message || reason,
    decision_support_only: true,
  };
}

function isMissingSchemaError(err) {
  return err?.meta?.code === '42P01' ||
    /does not exist|relation .* does not exist/i.test(String(err?.message || ''));
}

async function loadPatientRecordExtractionMap(records, patientId) {
  const keys = records
    .map((record) => String(record.file_key || '').trim())
    .filter(Boolean);
  if (!keys.length) return new Map();

  const placeholders = keys.map((_, index) => `$${index + 1}`).join(',');
  try {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT DISTINCT ON (cdi.storage_key)
              cdi.storage_key,
              cdi.id AS ai_intake_id,
              cdi.extraction_status AS ai_extraction_status,
              cdi.document_type AS ai_document_type,
              cdi.extracted_fields AS ai_extracted_fields,
              cdi.normalized_sections AS ai_normalized_sections,
              cdi.source_citations AS ai_source_citations,
              cdi.safety_flags AS ai_safety_flags,
              cdi.reviewer_decision AS ai_reviewer_decision,
              cdi.reviewed_at AS ai_reviewed_at,
              cdi.reviewer_note AS ai_reviewer_note,
              cdi.metadata AS ai_metadata
         FROM clinical_document_intake cdi
         JOIN users pu ON pu.uid = cdi.patient_uid
        WHERE cdi.storage_key IN (${placeholders})
          AND pu.id = $${keys.length + 1}
        ORDER BY cdi.storage_key, cdi.created_at DESC`,
      ...keys,
      patientId
    );
    return new Map(rows.map((row) => [row.storage_key, row]));
  } catch (err) {
    if (isMissingSchemaError(err)) return new Map();
    throw err;
  }
}

async function findPatientRecordWithExtraction(req, recordId, { includeRawText = false } = {}) {
  const id = Number.parseInt(recordId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error('Invalid record id');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  const role = String(req.user?.role || '').toUpperCase();
  const patientOnlyClause = role === 'PATIENT' ? 'AND pr.patient_id = $2' : '';
  const params = role === 'PATIENT' ? [id, req.user?.id] : [id];
  const rows = await prisma.$queryRawUnsafe(
    `SELECT pr.id, pr.patient_id, pr.document_type, pr.title, pr.file_key,
            pr.file_url, pr.file_name, pr.file_size, pr.file_mime,
            pr.source_hospital, pr.record_date, pr.notes, pr.created_at,
            pr.tenant_id, pu.uid AS patient_uid,
            cdi.id AS ai_intake_id,
            cdi.extraction_status AS ai_extraction_status,
            cdi.document_type AS ai_document_type,
            cdi.extracted_fields AS ai_extracted_fields,
            cdi.normalized_sections AS ai_normalized_sections,
            cdi.source_citations AS ai_source_citations,
            cdi.safety_flags AS ai_safety_flags,
            cdi.reviewer_decision AS ai_reviewer_decision,
            cdi.reviewed_at AS ai_reviewed_at,
            cdi.reviewer_note AS ai_reviewer_note,
            cdi.metadata AS ai_metadata,
            ${includeRawText ? 'cdi.raw_text' : 'NULL'} AS ai_raw_text
       FROM patient_records pr
       JOIN users pu ON pu.id = pr.patient_id
       LEFT JOIN LATERAL (
         SELECT *
           FROM clinical_document_intake cdi
          WHERE cdi.storage_key = pr.file_key
            AND cdi.tenant_id = pr.tenant_id
          ORDER BY cdi.created_at DESC
          LIMIT 1
       ) cdi ON TRUE
      WHERE pr.id = $1
        ${patientOnlyClause}
      LIMIT 1`,
    ...params
  );

  if (!rows.length) {
    const err = new Error('Record not found');
    err.statusCode = HTTP_STATUS.NOT_FOUND;
    throw err;
  }
  return rows[0];
}

async function resolvePatientForRecordUpload(req) {
  const role = String(req.user?.role || '').toUpperCase();
  if (role === 'PATIENT') {
    return req.user?.id;
  }

  const explicitId = parseInt(req.body.patient_id, 10);
  if (Number.isFinite(explicitId)) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id, role FROM users WHERE id=$1 LIMIT 1`,
      explicitId,
    );
    if (!rows.length) {
      const err = new Error('Patient not found');
      err.statusCode = HTTP_STATUS.NOT_FOUND;
      throw err;
    }
    if (rows[0].role !== 'PATIENT') {
      const err = new Error('Target user is not a patient');
      err.statusCode = HTTP_STATUS.CONFLICT;
      throw err;
    }
    return rows[0].id;
  }

  const patientPhone = normalizePhone(req.body.patient_phone);
  if (!patientPhone) {
    const err = new Error('patient_phone or patient_id is required');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  const last10 = patientPhone.replace(/\D/g, '').slice(-10);
  const existing = await prisma.$queryRawUnsafe(
    `SELECT id, role
       FROM users
      WHERE phone = $1 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $2
      ORDER BY CASE WHEN phone = $1 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
      LIMIT 1`,
    patientPhone,
    `%${last10}`,
  );

  if (existing.length > 0) {
    if (existing[0].role !== 'PATIENT') {
      const err = new Error('This phone number belongs to a non-patient account');
      err.statusCode = HTTP_STATUS.CONFLICT;
      throw err;
    }
    return existing[0].id;
  }

  const patientName = String(req.body.patient_name || '').trim() || 'New Patient';
  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO users (phone, name, role, registered_at, updated_at)
     VALUES ($1, $2, 'PATIENT', NOW(), NOW())
     RETURNING id`,
    patientPhone,
    patientName,
  );
  return created[0].id;
}

async function resolvePatientForRecordList(req) {
  const role = String(req.user?.role || '').toUpperCase();
  if (role === 'PATIENT') {
    return req.user?.id;
  }

  const explicitId = parseInt(req.query.patient_id, 10);
  const patientUid = String(req.query.patient_uid || '').trim();
  const patientPhone = normalizePhone(req.query.patient_phone);

  let rows = [];
  if (Number.isFinite(explicitId)) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, role FROM users WHERE id=$1 LIMIT 1`,
      explicitId,
    );
  } else if (patientUid) {
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, role FROM users WHERE uid=$1::uuid LIMIT 1`,
      patientUid,
    );
  } else if (patientPhone) {
    const last10 = patientPhone.replace(/\D/g, '').slice(-10);
    rows = await prisma.$queryRawUnsafe(
      `SELECT id, role
         FROM users
        WHERE phone = $1 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $2
        ORDER BY CASE WHEN phone = $1 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
        LIMIT 1`,
      patientPhone,
      `%${last10}`,
    );
  } else {
    const err = new Error('patient_id, patient_uid, or patient_phone is required');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  if (!rows.length) {
    const err = new Error('Patient not found');
    err.statusCode = HTTP_STATUS.NOT_FOUND;
    throw err;
  }
  if (rows[0].role !== 'PATIENT') {
    const err = new Error('Target user is not a patient');
    err.statusCode = HTTP_STATUS.CONFLICT;
    throw err;
  }
  return rows[0].id;
}

async function ensurePatientRecordAccess(req, res, {
  patient = null,
  patientId = null,
  patientUid = null,
  policyCode = ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
  recordType = 'PATIENT_RECORD',
  shadowMode = false,
} = {}) {
  const targetPatient = patient || {
    id: patientId,
    uid: patientUid,
  };
  const decision = await authorizePatientAccessRequest(req, {
    policyCode,
    recordType,
    patient: targetPatient,
    shadowMode,
    requireResolvedPatient: true,
  });

  if (!decision.allowed) {
    error(
      res,
      decision.safe_denial_message || SAFE_PATIENT_ACCESS_DENIAL_MESSAGE,
      HTTP_STATUS.FORBIDDEN,
      {
        safe: true,
        code: decision.safe_reason_code || 'PATIENT_ACCESS_DENIED',
        break_glass_available: Boolean(decision.break_glass_available),
        policy_code: decision.policy_code,
        policy_version: decision.policy_version,
        policy_hash: decision.policy_hash,
      }
    );
    return false;
  }
  return true;
}

function normalizeOptionalIsoDate(value, fieldName) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const err = new Error(`${fieldName} must be in YYYY-MM-DD format`);
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  const date = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) {
    const err = new Error(`${fieldName} is not a valid date`);
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }

  return raw;
}

/**
 * Upload prescription/scan after appointment (staff/doctor)
 * Expects multipart/form-data with file + metadata
 */
export const uploadAppointmentDocument = async (req, res) => {
  try {
    const { appointment_id, document_type, notes } = req.body;
    const uploadedById = req.user?.id;
    const uploadRole = req.user?.role === 'PATIENT' ? 'patient' : 'staff';

    if (!appointment_id || !req.file) {
      return error(res, 'appointment_id and file are required', HTTP_STATUS.BAD_REQUEST);
    }

    const appt = await prisma.$queryRawUnsafe('SELECT id, patient_id, doctor_id FROM appointments WHERE id=$1::int', appointment_id);
    if (!appt.length) return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    const a = appt[0];

    const timestamp = Date.now();
    const ext = req.file.originalname.split('.').pop();
    const fileKey = `records/appointments/${appointment_id}/${timestamp}.${ext}`;

    let fileUrl = null;
    try {
      await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);
      fileUrl = await getSignedFileUrl(fileKey, 3600, { baseUrl: `${req.protocol}://${req.get('host')}` }).catch(() => null);
    } catch (uploadErr) {
      logger.warn('R2 upload failed:', uploadErr.message);
      return error(res, 'File upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO appointment_documents
        (appointment_id, patient_id, doctor_id, uploaded_by, upload_role,
         document_type, file_key, file_url, file_name, file_size, file_mime, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, appointment_id, patient_id, doctor_id, uploaded_by, upload_role, document_type, file_key, file_url, file_name, file_size, file_mime, notes, created_at
    `,
      appointment_id, a.patient_id, a.doctor_id, uploadedById, uploadRole,
      document_type || 'prescription', fileKey, fileUrl,
      req.file.originalname, req.file.size, req.file.mimetype, notes || null,
    );

    // Notify patient if staff upload
    if (uploadRole === 'staff' && a.patient_id) {
      const patient = await prisma.$queryRawUnsafe('SELECT device_token FROM users WHERE id=$1', a.patient_id);
      if (patient[0]?.device_token) {
        setImmediate(async () => {
          try {
            await sendPushNotification({
              tokens: patient[0].device_token,
              title: 'Document Available',
              body: `Your ${document_type || 'prescription'} from your recent visit is now available in Records.`,
              data: { type: 'document_uploaded', appointment_id: String(appointment_id) },
              userId: String(a.patient_id),
            });
          } catch (e) { logger.warn('Doc notification failed:', e.message); }
        });
      }
    }

    success(res, result[0], 'Document uploaded');
  } catch (err) {
    logger.error('Upload Appointment Doc Error:', err);
    error(res, 'Failed to upload document', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get documents for an appointment.
 *
 * Returns appointment_documents rows visible to the patient AND
 * synthesised entries for any e_prescriptions row created for this
 * appointment. The patient app's "View Prescription" CTA hits this
 * endpoint expecting to find the structured prescription document.
 * Before this synthesis, the structured Rx (e_prescriptions.pdf_key)
 * was completely separate from appointment_documents and the CTA
 * surfaced an empty list — finding
 * 2026-05-10-walk-in-opd-patient-appointment-prescription-empty.
 */
export const getAppointmentDocuments = async (req, res) => {
  try {
    const { appointment_id } = req.params;
    const apptId = parseInt(appointment_id, 10);
    if (!Number.isInteger(apptId) || apptId <= 0) {
      return error(res, 'Invalid appointment id', HTTP_STATUS.BAD_REQUEST);
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const [docRows, rxRows] = await Promise.all([
      prisma.$queryRawUnsafe(
        `SELECT ad.id, ad.appointment_id, ad.patient_id, ad.doctor_id, ad.uploaded_by, ad.upload_role, ad.document_type, ad.file_key, ad.file_url, ad.file_name, ad.file_size, ad.file_mime, ad.notes, ad.created_at, u.name as uploaded_by_name
         FROM appointment_documents ad
         LEFT JOIN users u ON ad.uploaded_by = u.id
         WHERE ad.appointment_id=$1::int AND ad.is_visible_to_patient=TRUE
         ORDER BY ad.created_at DESC`,
        apptId,
      ),
      prisma.$queryRawUnsafe(
        `SELECT ep.id, ep.appointment_id, ep.patient_id, ep.doctor_id,
                ep.prescription_number, ep.pdf_key, ep.created_at,
                d.name AS doctor_name
           FROM e_prescriptions ep
           LEFT JOIN users d ON d.id = ep.doctor_id
          WHERE ep.appointment_id = $1::int
          ORDER BY ep.created_at DESC`,
        apptId,
      ),
    ]);

    const docs = await Promise.all(docRows.map(async (doc) => {
      if (doc.file_key) {
        doc.file_url = await getSignedFileUrl(doc.file_key, 3600, { baseUrl }).catch(() => null);
      }
      return doc;
    }));

    // Synthesise document entries from e_prescriptions. We only emit
    // an entry per Rx when the PDF has been generated (pdf_key set) —
    // if generation failed at create-time, the patient-portal
    // /portal/prescriptions/:id/pdf endpoint will lazily regenerate
    // and stamp the key. Document IDs are prefixed `rx-` so they can't
    // collide with appointment_documents.id (BigInt).
    const rxDocs = await Promise.all(rxRows.filter((rx) => rx.pdf_key).map(async (rx) => {
      const file_url = await getSignedFileUrl(rx.pdf_key, 3600, { baseUrl }).catch(() => null);
      return {
        id: `rx-${rx.id}`,
        appointment_id: rx.appointment_id,
        patient_id: rx.patient_id,
        doctor_id: rx.doctor_id,
        uploaded_by: rx.doctor_id,
        uploaded_by_name: rx.doctor_name,
        upload_role: 'staff',
        document_type: 'prescription',
        file_key: rx.pdf_key,
        file_url,
        file_name: `${rx.prescription_number || `prescription-${rx.id}`}.pdf`,
        file_size: null,
        file_mime: 'application/pdf',
        notes: null,
        source: 'e_prescription',
        prescription_id: rx.id,
        created_at: rx.created_at,
      };
    }));

    const combined = [...docs, ...rxDocs].sort((a, b) => {
      const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      return tb - ta;
    });

    success(res, combined, 'Documents fetched');
  } catch (err) {
    logger.error('Get Appointment Docs Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get all records for a patient (appointment docs + patient-uploaded records)
 */
export const getPatientAllRecords = async (req, res) => {
  try {
    const patientId = await resolvePatientForRecordList(req);
    const hasAccess = await ensurePatientRecordAccess(req, res, {
      patientId,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_VIEW,
      recordType: 'PATIENT_RECORD',
    });
    if (!hasAccess) return;

    // Both `appointment_documents` and `patient_records` are part of an
    // unfinished records-management feature — the migrations were never
    // written. Using Promise.allSettled (per-query) so a missing table on
    // one side doesn't blank out the other. Each catch returns []; we
    // silently degrade to "no records" until the schema is built.
    const safeQuery = async (sql, ...params) => {
      try {
        return await prisma.$queryRawUnsafe(sql, ...params);
      } catch (e) {
        if (e?.meta?.code === '42P01') {return [];}
        throw e;
      }
    };

    const [apptDocs, ownRecords] = await Promise.all([
      safeQuery(`
        SELECT ad.id, ad.appointment_id, ad.patient_id, ad.doctor_id, ad.uploaded_by, ad.upload_role, ad.document_type, ad.file_key, ad.file_url, ad.file_name, ad.file_size, ad.file_mime, ad.notes, ad.created_at, 'appointment' as source,
          a.appointment_date, a.appointment_time,
          d.name as doctor_name, doc.department as doctor_department
        FROM appointment_documents ad
        JOIN appointments a ON ad.appointment_id = a.id
        LEFT JOIN users d ON a.doctor_id = d.id
        LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
        WHERE ad.patient_id=$1 AND ad.is_visible_to_patient=TRUE
        ORDER BY ad.created_at DESC
      `, patientId),
      safeQuery(
        `SELECT id, patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes, created_at, tenant_id, 'patient_upload' as source FROM patient_records WHERE patient_id=$1 ORDER BY created_at DESC`,
        patientId
      ),
    ]);

    const extractionMap = await loadPatientRecordExtractionMap(ownRecords, patientId);
    const ownRecordsWithExtraction = ownRecords.map((record) => {
      const extractionRow = extractionMap.get(String(record.file_key || ''));
      return extractionRow
        ? attachPatientRecordExtraction({ ...record, ...extractionRow })
        : record;
    });

    const allDocs = [...apptDocs, ...ownRecordsWithExtraction];
    const withUrls = await Promise.all(allDocs.map(async (doc) => {
      if (doc.file_key) {
        doc.file_url = await getSignedFileUrl(doc.file_key, 3600, { baseUrl: `${req.protocol}://${req.get('host')}` }).catch(() => null);
      }
      return doc;
    }));

    const grouped = {
      hospital_records: withUrls.filter(d => d.source === 'appointment'),
      my_uploads: withUrls.filter(d => d.source === 'patient_upload'),
      total: withUrls.length,
      patient_id: patientId,
    };

    success(res, grouped, 'All records fetched');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Get Patient Records Error:', err);
    error(res, 'Failed to fetch records', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Patient uploads their own prior records
 */
export const uploadPatientRecord = async (req, res) => {
  try {
    const patientId = await resolvePatientForRecordUpload(req);
    await ensurePatientRecordAccess(req, res, {
      patientId,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_UPLOAD,
      recordType: 'PATIENT_RECORD',
      shadowMode: true,
    });
    const { document_type, title, source_hospital, record_date, notes } = req.body;
    const normalizedRecordDate = normalizeOptionalIsoDate(record_date, 'record_date');

    if (!req.file || !title) return error(res, 'file and title are required', HTTP_STATUS.BAD_REQUEST);

    const timestamp = Date.now();
    const ext = req.file.originalname.split('.').pop();
    const fileKey = `records/patient_uploads/${patientId}/${timestamp}.${ext}`;

    let fileUrl = null;
    try {
      await uploadFileToR2(req.file.buffer, fileKey, req.file.mimetype);
      fileUrl = await getSignedFileUrl(fileKey, 3600, { baseUrl: `${req.protocol}://${req.get('host')}` }).catch(() => null);
    } catch (uploadErr) {
      logger.warn('Patient upload R2 failed:', uploadErr.message);
      return error(res, 'File upload failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
    }

    const result = await prisma.$queryRawUnsafe(`
      INSERT INTO patient_records
        (patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes, tenant_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11,$12::uuid)
      RETURNING id, patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes, created_at, tenant_id
    `,
      patientId, document_type || 'other', title,
      fileKey, fileUrl, req.file.originalname, req.file.size, req.file.mimetype,
      source_hospital || null, normalizedRecordDate, notes || null,
      req.tenantId || DEFAULT_TENANT_ID,
    );

    let aiExtraction = null;
    try {
      const patientRows = await prisma.$queryRawUnsafe(
        'SELECT uid FROM users WHERE id=$1 LIMIT 1',
        patientId
      );
      aiExtraction = await ingestClinicalDocumentUpload({
        req,
        file: req.file,
        patientUid: patientRows[0]?.uid || null,
        sourceType: document_type || 'other',
        title,
        storageKey: fileKey,
      });
    } catch (extractErr) {
      const disabled = extractErr?.statusCode === HTTP_STATUS.FORBIDDEN &&
        /Clinical AI module is disabled/i.test(String(extractErr?.message || ''));
      logger.warn('Patient record AI extraction skipped', {
        record_id: result[0]?.id?.toString?.() || result[0]?.id,
        reason: disabled ? 'document_intelligence_disabled' : 'extraction_failed',
        error: extractErr?.message,
      });
      aiExtraction = extractionUnavailable(
        disabled ? 'document_intelligence_disabled' : 'extraction_failed',
        extractErr
      );
    }

    success(res, { ...result[0], ai_extraction: aiExtraction }, 'Record uploaded');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Patient Upload Error:', err);
    error(res, 'Failed to upload record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Load the AI/OCR extraction draft attached to an uploaded patient record.
 */
export const getPatientRecordExtraction = async (req, res) => {
  try {
    const row = await findPatientRecordWithExtraction(req, req.params.id, {
      includeRawText: true,
    });
    const hasAccess = await ensurePatientRecordAccess(req, res, {
      patientId: row.patient_id,
      patientUid: row.patient_uid,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_VIEW,
      recordType: 'PATIENT_RECORD_EXTRACTION',
    });
    if (!hasAccess) return;
    if (!row.ai_intake_id) {
      return error(res, 'Extraction draft not found for this record', HTTP_STATUS.NOT_FOUND);
    }
    if (row.file_key) {
      row.file_url = await getSignedFileUrl(row.file_key, 3600, {
        baseUrl: `${req.protocol}://${req.get('host')}`,
      }).catch(() => row.file_url || null);
    }
    const record = attachPatientRecordExtraction(row, { includeRawText: true });
    success(res, {
      record,
      ai_extraction: record.ai_extraction,
    }, 'Record extraction fetched');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    if (isMissingSchemaError(err)) {
      return error(res, 'Extraction draft not found for this record', HTTP_STATUS.NOT_FOUND);
    }
    logger.error('Get Patient Record Extraction Error:', err);
    error(res, 'Failed to fetch extraction', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Staff/clinician review of the extraction draft. This records a review
 * decision only; it does not import facts into the chart.
 */
export const reviewPatientRecordExtraction = async (req, res) => {
  try {
    const row = await findPatientRecordWithExtraction(req, req.params.id);
    const hasAccess = await ensurePatientRecordAccess(req, res, {
      patientId: row.patient_id,
      patientUid: row.patient_uid,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_EXTRACTION_REVIEW,
      recordType: 'PATIENT_RECORD_EXTRACTION',
    });
    if (!hasAccess) return;
    if (!row.ai_intake_id) {
      return error(res, 'Extraction draft not found for this record', HTTP_STATUS.NOT_FOUND);
    }
    const result = await decideClinicalDocumentIntake({
      tenantId: req.tenantId || row.tenant_id,
      intakeId: row.ai_intake_id,
      decision: req.body?.decision,
      reviewerUid: req.user?.uid || null,
      note: req.body?.note || null,
    });
    success(res, {
      review: result,
      ai_extraction: {
        ...buildPatientRecordExtractionSummary(row),
        reviewer_decision: result.reviewer_decision,
        reviewed_at: result.reviewed_at,
        reviewer_note: result.reviewer_note,
      },
    }, 'Record extraction review saved');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Review Patient Record Extraction Error:', err);
    error(res, 'Failed to review extraction', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Delete patient's own uploaded record
 */
export const deletePatientRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const row = await findPatientRecordWithExtraction(req, id);
    const hasAccess = await ensurePatientRecordAccess(req, res, {
      patientId: row.patient_id,
      patientUid: row.patient_uid,
      policyCode: ACCESS_POLICY_CODES.PATIENT_RECORD_DELETE,
      recordType: 'PATIENT_RECORD',
    });
    if (!hasAccess) return;
    const record = await prisma.$queryRawUnsafe('SELECT id, file_key FROM patient_records WHERE id=$1 AND patient_id=$2', id, row.patient_id);
    if (!record.length) return error(res, 'Record not found', HTTP_STATUS.NOT_FOUND);

    const fileKey = record[0].file_key;
    setImmediate(async () => {
      try { await deleteObject(fileKey); } catch (e) { logger.warn('R2 delete failed:', e.message); }
    });

    await prisma.$queryRawUnsafe('DELETE FROM patient_records WHERE id=$1', id);
    success(res, { deleted: true }, 'Record deleted');
  } catch (err) {
    logger.error('Delete Patient Record Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Get all documents for admin view (all appointments)
 */
export const getAllDocumentsAdmin = async (req, res) => {
  try {
    const { from_date, to_date, limit = 50, offset = 0 } = req.query;
    let where = 'WHERE 1=1';
    const params = [];

    if (from_date) { params.push(from_date); where += ` AND DATE(ad.created_at) >= $${params.length}`; }
    if (to_date) { params.push(to_date); where += ` AND DATE(ad.created_at) <= $${params.length}`; }

    params.push(parseInt(limit));
    params.push(parseInt(offset));

    const result = await prisma.$queryRawUnsafe(`
      SELECT ad.id, ad.appointment_id, ad.patient_id, ad.doctor_id, ad.uploaded_by, ad.upload_role, ad.document_type, ad.file_key, ad.file_url, ad.file_name, ad.file_size, ad.file_mime, ad.notes, ad.created_at, u.name as uploaded_by_name,
        p.name as patient_name, d.name as doctor_name,
        a.appointment_date, a.appointment_time
      FROM appointment_documents ad
      LEFT JOIN users u ON ad.uploaded_by = u.id
      LEFT JOIN users p ON ad.patient_id = p.id
      LEFT JOIN users d ON ad.doctor_id = d.id
      LEFT JOIN appointments a ON ad.appointment_id = a.id
      ${where}
      ORDER BY ad.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, ...params);

    const docs = await Promise.all(result.map(async (doc) => {
      if (doc.file_key) {
        doc.file_url = await getSignedFileUrl(doc.file_key, 3600, { baseUrl: `${req.protocol}://${req.get('host')}` }).catch(() => null);
      }
      return doc;
    }));

    success(res, docs, 'Documents fetched');
  } catch (err) {
    logger.error('Get All Docs Error:', err);
    error(res, 'Failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
