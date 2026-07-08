// src/routes/consentRoutes.js
// HIPAA Patient Consent Management Routes

import crypto from 'crypto';
import { Router } from 'express';
import { validationResult } from 'express-validator';
import PDFDocument from 'pdfkit';
import prisma from '../lib/prisma.js';
import logger from '../logging/logger.js';
import { singleUpload, validateFileContent, validatePatientUpload } from '../middleware/uploadMiddleware.js';
import { publishEvent } from '../services/events/eventOutboxService.js';
import { resolveTenantOrThrow } from '../services/tenant/tenantService.js';
import { logPhiAccess } from '../utils/hipaaAudit.js';
import { logAudit } from '../utils/logAudit.js';
import { getFileFromR2, uploadFileToR2 } from '../utils/r2Storage.js';
import { success, error } from '../utils/responseHelper.js';
import { requiredUUID, requiredString } from '../validators/sharedValidators.js';

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
  next();
};

const router = Router();

const VALID_CONSENT_TYPES = [
  'data_access',
  'data_sharing',
  'treatment',
  // `procedure` — consent for a specific procedure/surgery, typically
  // captured at the pre-op OPD visit. The admission gate accepts a recent
  // `procedure` consent so a scheduled day-care/surgical patient doesn't
  // have to re-consent at the admission counter. Finding:
  //   2026-05-09-surgical-day-care-admission-consent-no-preop-carryover.
  'procedure',
  'research',
  'marketing',
  'telehealth',
  'general',
  'abdm',
  'insurance',
  // Explicit acknowledgement of patient-payable deltas such as TPA
  // room-upgrade differences. The claim submit gate accepts these as
  // evidence when the insurer caps the covered room category.
  'financial_liability',
  'room_upgrade_liability',
  'ai_documentation',
  // Explicit consent for ambient audio recording by the clinical AI scribe.
  // Required by ambientDocumentationService and nursingAmbientDocumentationService
  // (assertPatientConsentInTenant allowedTypes: ['recording_consent', 'treatment']).
  // Also accepted by voicePatientAssistantIvrService.
  'recording_consent',
  'marketing_whatsapp',
  'care_reminder_whatsapp',
  'rpm_monitoring',
  'nps_survey',
  'teleconsult_followup',
];

// Stage-5 — how consent was obtained. `thumbprint` / `verbal` are
// first-class for illiterate patients (NABH requires the method plus a
// witness on record); `signature` is the literate-patient default.
// Finding:
//   2026-05-09-inpatient-admission-admission-no-thumbprint-consent-illiterate.
const VALID_CONSENT_METHODS = ['signature', 'thumbprint', 'verbal'];

const VALID_DATA_RIGHT_TYPES = ['export', 'erasure', 'correction', 'restriction', 'consent_review'];
const VALID_DATA_RIGHT_STATUSES = ['submitted', 'in_review', 'completed', 'rejected', 'cancelled'];
const VALID_SIGNATURE_ROLES = ['patient', 'staff_witness'];
const SIGNATURE_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/jpg'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * IDOR guard: patients can only manage their own consents.
 * Staff/admin roles are allowed to manage any patient's consents.
 */
function enforceConsentOwnership(req, patientUid) {
  const role = (req.user?.role || '').toUpperCase();
  if (role === 'PATIENT' && String(req.user?.uid) !== String(patientUid)) {
    return false;
  }
  return true;
}

function isAdminOrClinicalStaff(req) {
  const role = (req.user?.role || '').toUpperCase();
  return ['ADMIN', 'SUPER_ADMIN', 'DOCTOR', 'NURSING_STAFF', 'MEDICAL_RECORDS'].includes(role);
}

function normalizeConsentStatus(row) {
  if (row.revoked_at || row.granted === false || row.status === 'revoked') return 'revoked';
  if (row.expires_at && new Date(row.expires_at) < new Date()) return 'expired';
  if (row.granted === true || row.status === 'active') return 'granted';
  return row.status || 'pending';
}

function normalizeSignatureRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return VALID_SIGNATURE_ROLES.includes(role) ? role : null;
}

function normalizeImageMime(mime) {
  const normalized = String(mime || '').trim().toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function signatureExtension(mime) {
  return normalizeImageMime(mime) === 'image/png' ? 'png' : 'jpg';
}

function signatureDto(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    consent_id: row.consent_id,
    patient_uid: row.patient_uid,
    signature_role: row.signature_role,
    version: row.version,
    storage_key: row.storage_key,
    mime_type: row.mime_type,
    file_size: row.file_size,
    sha256_hash: row.sha256_hash,
    captured_by: row.captured_by,
    captured_by_role: row.captured_by_role,
    signer_name: row.signer_name,
    signer_uid: row.signer_uid,
    captured_at: row.captured_at,
  };
}

async function getConsentById(consentId, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, patient_uid, consent_type, granted, status, granted_at, revoked_at,
            expires_at, granted_by, notes, purpose, data_categories, version,
            source, consent_method, witness_name, witness_uid, form_language,
            tenant_id, created_at
       FROM patient_consents
      WHERE id = $1::int
        AND tenant_id = $2::uuid
      LIMIT 1`,
    consentId,
    tenantId,
  );
  return rows[0] || null;
}

async function latestConsentSignatures(consentId, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT DISTINCT ON (signature_role)
            id, consent_id, patient_uid, signature_role, version, storage_key,
            mime_type, file_size, sha256_hash, captured_by, captured_by_role,
            signer_name, signer_uid, captured_at
       FROM consent_signatures
      WHERE consent_id = $1::int
        AND tenant_id = $2::uuid
      ORDER BY signature_role, version DESC`,
    consentId,
    tenantId,
  );
  return rows.map(signatureDto);
}

async function renderConsentPdf(consent, signatures) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const render = async () => {
      doc.fontSize(18).text('Patient Consent Record', { underline: true });
      doc.moveDown();
      doc.fontSize(11);
      doc.text(`Consent ID: ${consent.id}`);
      doc.text(`Patient UID: ${consent.patient_uid}`);
      doc.text(`Consent type: ${consent.consent_type}`);
      doc.text(`Status: ${normalizeConsentStatus(consent)}`);
      doc.text(`Method: ${consent.consent_method || 'signature'}`);
      if (consent.form_language) doc.text(`Form language: ${consent.form_language}`);
      if (consent.witness_name) doc.text(`Witness: ${consent.witness_name}`);
      if (consent.purpose) doc.text(`Purpose: ${consent.purpose}`);
      if (consent.notes) doc.text(`Notes: ${consent.notes}`);
      doc.moveDown();

      doc.fontSize(13).text('Captured Signatures', { underline: true });
      doc.moveDown(0.5);
      if (!signatures.length) {
        doc.fontSize(10).text('No signature images captured.');
      }
      for (const sig of signatures) {
        doc.fontSize(10).text(
          `${sig.signature_role === 'patient' ? 'Patient' : 'Staff witness'} signature` +
            ` | version ${sig.version} | captured ${new Date(sig.captured_at).toISOString()}`,
        );
        try {
          const bytes = await getFileFromR2(sig.storage_key);
          doc.image(Buffer.from(bytes), { fit: [220, 80] });
        } catch (imgErr) {
          logger.warn('Consent signature PDF image embed failed', {
            consent_id: consent.id,
            signature_id: sig.id,
            error: imgErr.message,
          });
          doc.text('[signature image unavailable]');
        }
        doc.moveDown();
      }

      doc.end();
    };

    render().catch(reject);
  });
}

/**
 * GET /consent
 * Admin/clinical list for consent center; patients receive only their own rows.
 */
router.get('/', async (req, res, next) => {
  try {
    const role = (req.user?.role || '').toUpperCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
    const patientUid = role === 'PATIENT'
      ? req.user?.uid
      : (req.query.patient_uid || null);

    if (role === 'PATIENT' && !patientUid) {
      return error(res, 'Patient UID missing from token', 400);
    }

    const conditions = [];
    const params = [];
    let idx = 1;

    if (patientUid) {
      conditions.push(`pc.patient_uid = $${idx}::uuid`);
      params.push(patientUid);
      idx++;
    }

    if (req.query.consent_type) {
      conditions.push(`pc.consent_type = $${idx}`);
      params.push(req.query.consent_type);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT pc.id, pc.patient_uid, u.name AS patient_name, u.phone AS patient_phone,
              pc.consent_type, pc.granted, pc.status, pc.granted_at, pc.revoked_at,
              pc.expires_at, pc.granted_by, pc.revoked_by, pc.notes, pc.purpose,
              pc.data_categories, pc.version, pc.source, pc.created_at, pc.updated_at
       FROM patient_consents pc
       LEFT JOIN users u ON u.uid = pc.patient_uid
       ${where}
       ORDER BY pc.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params,
      limit,
      offset
    );

    const records = rows.map((row) => ({
      ...row,
      status: normalizeConsentStatus(row),
    }));

    return success(res, records, 'Consent records retrieved');
  } catch (err) {
    logger.error('Failed to list consent records:', { error: err.message });
    next(err);
  }
});

/**
 * POST /consent/data-rights/request
 * Patient/staff data-rights intake: export, erasure, correction, restriction.
 */
router.post('/data-rights/request', requiredUUID('patient_uid'), requiredString('request_type', 50), validate, async (req, res, next) => {
  try {
    const { patient_uid, request_type, notes } = req.body;
    const normalizedType = String(request_type || '').toLowerCase();

    if (!VALID_DATA_RIGHT_TYPES.includes(normalizedType)) {
      return error(res, `Invalid request_type. Must be one of: ${VALID_DATA_RIGHT_TYPES.join(', ')}`, 400);
    }

    if (!enforceConsentOwnership(req, patient_uid)) {
      return error(res, 'Access denied: You can only request data rights for your own record', 403);
    }

    const dueAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_data_rights_requests
         (patient_uid, request_type, status, requested_by, request_source, due_at, notes, created_at, updated_at)
       VALUES ($1::uuid, $2, 'submitted', $3::uuid, 'portal', $4::timestamptz, $5, NOW(), NOW())
       RETURNING id, patient_uid, request_type, status, requested_by, due_at, notes, created_at`,
      patient_uid,
      normalizedType,
      req.user?.uid || null,
      dueAt,
      notes || null
    );

    await publishEvent({
      eventType: 'privacy.data_rights.requested',
      aggregateType: 'patient_data_rights_request',
      aggregateId: rows[0].id,
      patientUid: patient_uid,
      payload: {
        request_type: normalizedType,
        requested_by: req.user?.uid || null,
        due_at: dueAt,
      },
    });

    return success(res, rows[0], 'Data rights request submitted', 201);
  } catch (err) {
    logger.error('Failed to create data rights request:', { error: err.message });
    next(err);
  }
});

router.get('/data-rights', async (req, res, next) => {
  try {
    const role = (req.user?.role || '').toUpperCase();
    const patientUid = role === 'PATIENT'
      ? req.user?.uid
      : (req.query.patient_uid || null);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const conditions = [];
    const params = [];
    let idx = 1;

    if (patientUid) {
      conditions.push(`dr.patient_uid = $${idx}::uuid`);
      params.push(patientUid);
      idx++;
    }
    if (req.query.status) {
      conditions.push(`dr.status = $${idx}`);
      params.push(req.query.status);
      idx++;
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await prisma.$queryRawUnsafe(
      `SELECT dr.id, dr.patient_uid, u.name AS patient_name, dr.request_type,
              dr.status, dr.requested_by, dr.request_source, dr.due_at,
              dr.notes, dr.resolution, dr.completed_at, dr.created_at, dr.updated_at
       FROM patient_data_rights_requests dr
       LEFT JOIN users u ON u.uid = dr.patient_uid
       ${where}
       ORDER BY dr.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      ...params,
      limit,
      offset
    );

    return success(res, rows, 'Data rights requests retrieved');
  } catch (err) {
    logger.error('Failed to list data rights requests:', { error: err.message });
    next(err);
  }
});

router.patch('/data-rights/:id', async (req, res, next) => {
  try {
    if (!isAdminOrClinicalStaff(req)) {
      return error(res, 'Only authorized staff can update data rights requests', 403);
    }

    const id = parseInt(req.params.id, 10);
    const { status, resolution } = req.body || {};
    const normalizedStatus = String(status || '').toLowerCase();
    if (!VALID_DATA_RIGHT_STATUSES.includes(normalizedStatus)) {
      return error(res, `Invalid status. Must be one of: ${VALID_DATA_RIGHT_STATUSES.join(', ')}`, 400);
    }

    const rows = await prisma.$queryRawUnsafe(
      `UPDATE patient_data_rights_requests
       SET status = $2,
           resolution = $3::jsonb,
           completed_at = CASE WHEN $2 IN ('completed', 'rejected', 'cancelled') THEN NOW() ELSE completed_at END,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, patient_uid, request_type, status, resolution, completed_at, updated_at`,
      id,
      normalizedStatus,
      resolution ? JSON.stringify(resolution) : null
    );

    if (!rows.length) return error(res, 'Data rights request not found', 404);

    await publishEvent({
      eventType: 'privacy.data_rights.updated',
      aggregateType: 'patient_data_rights_request',
      aggregateId: rows[0].id,
      patientUid: rows[0].patient_uid,
      payload: {
        status: rows[0].status,
        updated_by: req.user?.uid || null,
      },
    });

    return success(res, rows[0], 'Data rights request updated');
  } catch (err) {
    logger.error('Failed to update data rights request:', { error: err.message });
    next(err);
  }
});

/**
 * POST /consent/grant
 * Grant a consent for a patient.
 * Body: { patient_uid, consent_type, notes? }
 */
router.post('/grant', requiredUUID('patient_uid'), requiredString('consent_type', 100), validate, async (req, res, next) => {
  try {
    const { patient_uid, consent_type, notes, witness_name, witness_uid, form_language } = req.body;

    if (!patient_uid || !consent_type) {
      return error(res, 'patient_uid and consent_type are required', 400);
    }

    // IDOR check: patients can only grant their own consents
    if (!enforceConsentOwnership(req, patient_uid)) {
      return error(res, 'Access denied: You can only manage your own consents', 403);
    }

    if (!VALID_CONSENT_TYPES.includes(consent_type)) {
      return error(res, `Invalid consent_type. Must be one of: ${VALID_CONSENT_TYPES.join(', ')}`, 400);
    }

    // Stage-5 — consent capture method. Optional; defaults to `signature`
    // (the literate-patient case). `thumbprint` / `verbal` make consent
    // obtained from an illiterate patient first-class instead of forcing
    // staff to improvise in the free-text `notes` field.
    const consentMethod = req.body.consent_method
      ? String(req.body.consent_method).trim().toLowerCase()
      : 'signature';
    if (!VALID_CONSENT_METHODS.includes(consentMethod)) {
      return error(res, `Invalid consent_method. Must be one of: ${VALID_CONSENT_METHODS.join(', ')}`, 400);
    }
    // A thumbprint or verbal consent is medico-legally contestable
    // without a named witness — NABH requires one on record.
    const witnessName = witness_name ? String(witness_name).trim().slice(0, 160) : null;
    if ((consentMethod === 'thumbprint' || consentMethod === 'verbal') && !witnessName) {
      return error(res, `consent_method '${consentMethod}' requires witness_name`, 400);
    }
    // witness_uid is optional — only set when the witness is a system
    // user (a staff member). Validate the UUID shape if provided.
    let witnessUid = null;
    if (witness_uid !== undefined && witness_uid !== null && String(witness_uid).trim() !== '') {
      const w = String(witness_uid).trim();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(w)) {
        return error(res, 'witness_uid must be a valid UUID', 400);
      }
      witnessUid = w;
    }
    // Stage-5 — record which language the consent form was presented in,
    // so a Tamil-only patient's consent isn't silently assumed to be in
    // English. The translated consent-form *text* itself is out of scope
    // here — [PLACEHOLDER - legal/translation review required]. Finding:
    //   2026-05-09-inpatient-admission-admission-no-cmchis-flag-no-tamil-consent.
    const formLanguage = form_language
      ? String(form_language).trim().toLowerCase().slice(0, 20)
      : null;

    const grantedBy = req.user?.role?.toLowerCase() || 'patient';
    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    // Check if an active consent of this type already exists
    const existing = await prisma.$queryRawUnsafe(
      `SELECT id FROM patient_consents
       WHERE patient_uid = $1::uuid AND consent_type = $2 AND granted = true AND revoked_at IS NULL
       LIMIT 1`,
      patient_uid, consent_type
    );

    if (existing.length > 0) {
      return error(res, 'Active consent of this type already exists for this patient', 409);
    }

    const result = await prisma.$queryRawUnsafe(
      `INSERT INTO patient_consents
        (patient_uid, consent_type, granted, status, granted_at, granted_by, ip_address,
         notes, purpose, data_categories, expires_at,
         consent_method, witness_name, witness_uid, form_language,
         created_at, updated_at)
       VALUES ($1::uuid, $2, true, 'active', NOW(), $3, $4, $5, $6, $7::jsonb,
               $8::timestamptz, $9, $10, $11::uuid, $12,
               NOW(), NOW())
       RETURNING id, patient_uid, consent_type, granted, status, granted_at, granted_by,
                 ip_address, notes, purpose, data_categories, expires_at,
                 consent_method, witness_name, witness_uid, form_language, created_at`,
      patient_uid,
      consent_type,
      grantedBy,
      ip,
      notes || null,
      req.body.purpose || null,
      JSON.stringify(req.body.data_categories || []),
      req.body.expires_at || null,
      consentMethod,
      witnessName,
      witnessUid,
      formLanguage
    );

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patient_uid,
      recordType: `consent:${consent_type}`,
      action: 'GRANT_CONSENT',
      ip,
      requestId: req.id,
    });

    logger.info('Consent granted', { patient_uid, consent_type, granted_by: grantedBy });

    await publishEvent({
      eventType: 'privacy.consent.granted',
      aggregateType: 'patient_consent',
      aggregateId: result[0].id,
      patientUid: patient_uid,
      payload: { consent_type, granted_by: grantedBy },
    });

    return success(res, result[0], 'Consent granted successfully', 201);
  } catch (err) {
    logger.error('Failed to grant consent:', { error: err.message });
    next(err);
  }
});

/**
 * POST /consent/:id/signatures
 * Multipart field: file. Body: signature_role = patient | staff_witness.
 * Signature capture is immutable: a repeat upload inserts version N+1.
 */
router.post('/:id/signatures', singleUpload, validatePatientUpload, validateFileContent, async (req, res, next) => {
  try {
    const consentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(consentId) || consentId <= 0) {
      return error(res, 'Consent id must be a positive integer', 400);
    }
    if (!req.file) {
      return error(res, 'Signature image is required', 400);
    }

    const signatureRole = normalizeSignatureRole(req.body.signature_role);
    if (!signatureRole) {
      return error(res, `signature_role must be one of: ${VALID_SIGNATURE_ROLES.join(', ')}`, 400);
    }

    const mimeType = normalizeImageMime(req.file.mimetype);
    if (!SIGNATURE_IMAGE_MIMES.includes(mimeType)) {
      return error(res, 'Signature must be a PNG or JPEG image', 400);
    }

    const tenantId = resolveTenantOrThrow(req);
    const consent = await getConsentById(consentId, tenantId);
    if (!consent) {
      return error(res, 'Consent record not found', 404);
    }
    if (!enforceConsentOwnership(req, consent.patient_uid)) {
      return error(res, 'Access denied: You can only sign your own consents', 403);
    }

    const versionRows = await prisma.$queryRawUnsafe(
      `SELECT COALESCE(MAX(version), 0) + 1 AS version
         FROM consent_signatures
        WHERE tenant_id = $1::uuid
          AND consent_id = $2::int
          AND signature_role = $3`,
      tenantId,
      consentId,
      signatureRole,
    );
    const version = Number(versionRows[0]?.version || 1);
    const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
    const storageKey = [
      'consent-signatures',
      tenantId,
      String(consentId),
      signatureRole,
      `v${version}_${Date.now()}.${signatureExtension(mimeType)}`,
    ].join('/');
    const storageUrl = await uploadFileToR2(req.file.buffer, storageKey, mimeType);

    const signerUid = req.body.signer_uid
      ? String(req.body.signer_uid).trim()
      : signatureRole === 'staff_witness'
        ? req.user?.uid || null
        : consent.patient_uid;
    if (signerUid && !UUID_PATTERN.test(signerUid)) {
      return error(res, 'signer_uid must be a valid UUID', 400);
    }
    const signerName = req.body.signer_name
      ? String(req.body.signer_name).trim().slice(0, 160)
      : null;

    const rows = await prisma.$queryRawUnsafe(
      `INSERT INTO consent_signatures
         (tenant_id, consent_id, patient_uid, signature_role, version,
          storage_key, storage_url, mime_type, file_size, sha256_hash,
          captured_by, captured_by_role, signer_name, signer_uid, metadata)
       VALUES ($1::uuid, $2::int, $3::uuid, $4, $5::int,
               $6, $7, $8, $9::int, $10,
               $11::uuid, $12, $13, $14::uuid, $15::jsonb)
       RETURNING id, consent_id, patient_uid, signature_role, version, storage_key,
                 mime_type, file_size, sha256_hash, captured_by, captured_by_role,
                 signer_name, signer_uid, captured_at`,
      tenantId,
      consentId,
      consent.patient_uid,
      signatureRole,
      version,
      storageKey,
      storageUrl,
      mimeType,
      req.file.size,
      hash,
      req.user?.uid || null,
      req.user?.role || null,
      signerName,
      signerUid,
      JSON.stringify({
        original_name: req.file.originalname || null,
        consent_type: consent.consent_type,
      }),
    );

    await logAudit(req, 'CONSENT_SIGNATURE_CAPTURED', {
      consent_id: consentId,
      patient_uid: consent.patient_uid,
      consent_type: consent.consent_type,
      signature_role: signatureRole,
      version,
      storage_key: storageKey,
      sha256_hash: hash,
    }, {
      resource: 'patient_consent',
      resourceId: consentId,
    });

    await publishEvent({
      eventType: 'privacy.consent.signature_captured',
      aggregateType: 'patient_consent',
      aggregateId: consentId,
      patientUid: consent.patient_uid,
      payload: {
        signature_role: signatureRole,
        version,
        captured_by: req.user?.uid || null,
      },
    });

    return success(res, signatureDto(rows[0]), 'Consent signature captured', 201);
  } catch (err) {
    logger.error('Failed to capture consent signature:', { error: err.message });
    next(err);
  }
});

/**
 * GET /consent/:id/pdf
 * Render a patient consent record with latest captured signatures embedded.
 */
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const consentId = parseInt(req.params.id, 10);
    if (!Number.isFinite(consentId) || consentId <= 0) {
      return error(res, 'Consent id must be a positive integer', 400);
    }
    const tenantId = resolveTenantOrThrow(req);
    const consent = await getConsentById(consentId, tenantId);
    if (!consent) {
      return error(res, 'Consent record not found', 404);
    }
    if (!enforceConsentOwnership(req, consent.patient_uid)) {
      return error(res, 'Access denied: You can only view your own consents', 403);
    }

    const signatures = await latestConsentSignatures(consentId, tenantId);
    const pdfBuffer = await renderConsentPdf(consent, signatures);

    await logAudit(req, 'CONSENT_PDF_RENDERED', {
      consent_id: consentId,
      patient_uid: consent.patient_uid,
      signature_count: signatures.length,
    }, {
      resource: 'patient_consent',
      resourceId: consentId,
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="consent_${consentId}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    logger.error('Failed to render consent PDF:', { error: err.message });
    next(err);
  }
});

/**
 * POST /consent/revoke
 * Revoke a consent for a patient.
 * Body: { patient_uid, consent_type }
 */
router.post('/revoke', requiredUUID('patient_uid'), requiredString('consent_type', 100), validate, async (req, res, next) => {
  try {
    const { patient_uid, consent_type } = req.body;

    if (!patient_uid || !consent_type) {
      return error(res, 'patient_uid and consent_type are required', 400);
    }

    // IDOR check: patients can only revoke their own consents
    if (!enforceConsentOwnership(req, patient_uid)) {
      return error(res, 'Access denied: You can only manage your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `UPDATE patient_consents
       SET revoked_at = NOW(), granted = false, status = 'revoked',
           revoked_by = $3, updated_at = NOW()
       WHERE patient_uid = $1::uuid
         AND consent_type = $2
         AND granted = true
         AND revoked_at IS NULL
       RETURNING id, patient_uid, consent_type, granted, status, granted_at, revoked_at, revoked_by`,
      patient_uid, consent_type, req.user?.uid || req.user?.role || 'unknown'
    );

    if (result.length === 0) {
      return error(res, 'No active consent found to revoke', 404);
    }

    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patient_uid,
      recordType: `consent:${consent_type}`,
      action: 'REVOKE_CONSENT',
      ip,
      requestId: req.id,
    });

    logger.info('Consent revoked', { patient_uid, consent_type });

    await publishEvent({
      eventType: 'privacy.consent.revoked',
      aggregateType: 'patient_consent',
      aggregateId: result[0].id,
      patientUid: patient_uid,
      payload: { consent_type, revoked_by: req.user?.uid || null },
    });

    return success(res, result[0], 'Consent revoked successfully');
  } catch (err) {
    logger.error('Failed to revoke consent:', { error: err.message });
    next(err);
  }
});

/**
 * GET /consent/:patientUid
 * Get all consents for a patient.
 */
router.get('/:patientUid', async (req, res, next) => {
  try {
    const { patientUid } = req.params;

    if (!patientUid) {
      return error(res, 'Patient UID is required', 400);
    }

    // IDOR check: patients can only view their own consents
    if (!enforceConsentOwnership(req, patientUid)) {
      return error(res, 'Access denied: You can only view your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, consent_type, granted, granted_at, revoked_at,
              granted_by, ip_address, notes, created_at
       FROM patient_consents
      WHERE patient_uid = $1::uuid
       ORDER BY created_at DESC`,
      patientUid
    );

    const ip = req.ip || req.headers['x-forwarded-for'] || null;

    logPhiAccess({
      userId: req.user?.uid || req.user?.id,
      userRole: req.user?.role,
      patientId: patientUid,
      recordType: 'consent:all',
      action: 'VIEW_CONSENTS',
      ip,
      requestId: req.id,
    });

    return success(res, result, 'Patient consents retrieved');
  } catch (err) {
    logger.error('Failed to get patient consents:', { error: err.message });
    next(err);
  }
});

/**
 * GET /consent/:patientUid/:consentType
 * Check specific consent for a patient.
 */
router.get('/:patientUid/:consentType', async (req, res, next) => {
  try {
    const { patientUid, consentType } = req.params;

    if (!patientUid || !consentType) {
      return error(res, 'Patient UID and consent type are required', 400);
    }

    // IDOR check: patients can only check their own consent status
    if (!enforceConsentOwnership(req, patientUid)) {
      return error(res, 'Access denied: You can only view your own consents', 403);
    }

    const result = await prisma.$queryRawUnsafe(
      `SELECT id, patient_uid, consent_type, granted, granted_at, revoked_at,
              granted_by, ip_address, notes, created_at
       FROM patient_consents
      WHERE patient_uid = $1::uuid
         AND consent_type = $2
       ORDER BY created_at DESC
       LIMIT 1`,
      patientUid, consentType
    );

    if (result.length === 0) {
      return success(res, { has_consent: false, consent: null }, 'No consent record found');
    }

    const consent = result[0];
    const isActive = consent.granted === true && consent.revoked_at === null;

    return success(res, {
      has_consent: isActive,
      consent,
    }, isActive ? 'Active consent found' : 'Consent is not active');
  } catch (err) {
    logger.error('Failed to check consent:', { error: err.message });
    next(err);
  }
});

export default router;
