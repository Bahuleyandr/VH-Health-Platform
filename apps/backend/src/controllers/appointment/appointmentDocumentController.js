// src/controllers/appointment/appointmentDocumentController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { sendPushNotification } from '../../utils/notifications/sendPushNotification.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { uploadFileToR2, getSignedFileUrl, deleteObject } from '../../utils/r2Storage.js';
import { success, error } from '../../utils/responseHelper.js';

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
    const patientId = req.user?.id;

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
        `SELECT id, patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes, created_at, 'patient_upload' as source FROM patient_records WHERE patient_id=$1 ORDER BY created_at DESC`,
        patientId
      ),
    ]);

    const allDocs = [...apptDocs, ...ownRecords];
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
    };

    success(res, grouped, 'All records fetched');
  } catch (err) {
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
        (patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::date,$11)
      RETURNING id, patient_id, document_type, title, file_key, file_url, file_name, file_size, file_mime, source_hospital, record_date, notes, created_at
    `,
      patientId, document_type || 'other', title,
      fileKey, fileUrl, req.file.originalname, req.file.size, req.file.mimetype,
      source_hospital || null, normalizedRecordDate, notes || null,
    );

    success(res, result[0], 'Record uploaded');
  } catch (err) {
    if (err?.statusCode) return error(res, err.message, err.statusCode);
    logger.error('Patient Upload Error:', err);
    error(res, 'Failed to upload record', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

/**
 * Delete patient's own uploaded record
 */
export const deletePatientRecord = async (req, res) => {
  try {
    const patientId = req.user?.id;
    const { id } = req.params;
    const record = await prisma.$queryRawUnsafe('SELECT id, file_key FROM patient_records WHERE id=$1 AND patient_id=$2', id, patientId);
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
