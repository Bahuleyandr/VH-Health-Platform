// src/controllers/patient/patientSearchController.js
//
// Lightweight patient lookup for clinical staff.
//
// Backs the staff app's global patient picker (Cmd+K modal). Returns a
// short list of patients matching the query string against name, phone,
// or ABHA address. Result is intentionally small — id/uid/name/age/gender/phone
// — because the picker just needs enough to render the row and route to
// /emr/timeline/:uid?name=… on tap. Full chart fetches happen via the
// EMR endpoints once the user lands on the patient screen.
//
// Why this lives at /api/v1/patients/search instead of reusing
// /api/v1/users/search:
//   * /users is RBAC'd to [PATIENT, GENERAL_STAFF, ADMIN] — clinical
//     roles 403 there, by design (it exposes admin-style filters like
//     `registeredAfter`, `lastLoginAfter`, full role enumeration).
//   * Clinical staff need a narrower verb: "find a patient by name or
//     phone, give me 20 rows max, no PII filters." A dedicated
//     endpoint keeps the search surface auditable and lets us add
//     IDOR/PHI guarding here without weakening the admin one.
//
// PHI access is still logged via the route-level `phiAccessLogger`
// middleware in `routes/patient/patientSearchRoutes.js`.

import crypto from 'crypto';

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import {
  findRegistrationDuplicateCandidates,
  recordRegistrationDuplicateOverride,
} from '../../services/patient/patientDedupeService.js';
import { screenUploadBuffer } from '../../services/security/fileScanService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { logAudit } from '../../utils/logAudit.js';
import { isValidPhone, normalizePhone } from '../../utils/phoneUtils.js';
import { uploadFileToR2 } from '../../utils/r2Storage.js';
import { error, success } from '../../utils/responseHelper.js';
import { withAuthIdentityLifecycleLocks } from '../../utils/tokenBlacklist.js';

const MIN_QUERY_LENGTH = 2;
const MAX_RESULTS = 20;
const PHONE_QUERY_RE = /^[+\d\s().-]+$/;
// Wristband QR payloads carry the patient UID (same convention as the MAR
// 5-rights scan flow). A UUID query resolves by exact uid match so bedside
// flows can positively identify the patient (STF-4).
const UUID_QUERY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DUPLICATE_OVERRIDE_MIN_REASON = 10;
const PROFILE_PHOTO_MIMES = new Set(['image/jpeg', 'image/png']);

function validPatientPhone(rawValue) {
  const raw = String(rawValue ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 10) return null;
  const normalized = normalizePhone(raw);
  return normalized && isValidPhone(normalized) ? normalized : null;
}

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

function normalizeGender(value) {
  const first = String(value ?? '').trim().toLowerCase().slice(0, 1);
  if (first === 'm') return 'male';
  if (first === 'f') return 'female';
  if (first === 'o') return 'other';
  return null;
}

function normalizeBirthday(value) {
  const raw = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function publicPatient(row) {
  if (!row) return row;
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    phone: row.phone,
    gender: row.gender,
    birthday: row.birthday,
    age: row.age,
    address: row.address,
    hospital_number: row.hospital_number,
    abha_address: row.abha_address,
    profile_picture: row.profile_picture,
  };
}

function duplicateReviewResponse(res, candidates) {
  return error(res, 'Potential duplicate patient requires review', HTTP_STATUS.CONFLICT, {
    topLevel: { code: 'PATIENT_DUPLICATE_REVIEW_REQUIRED' },
    duplicate_review_required: true,
    candidates,
  });
}

function duplicateOverrideReason(body) {
  return String(
    body.duplicate_override_reason ??
      body.create_anyway_reason ??
      body.duplicate_review_reason ??
      '',
  ).trim();
}

function imageExtension(mimeType) {
  return mimeType === 'image/png' ? 'png' : 'jpg';
}

async function uploadPatientProfilePhoto({ file, tenantId }) {
  if (!file) return null;
  const mimeType = String(file.mimetype || '').toLowerCase();
  if (!PROFILE_PHOTO_MIMES.has(mimeType)) {
    const err = new Error('Patient profile photo must be a JPEG or PNG image');
    err.statusCode = HTTP_STATUS.BAD_REQUEST;
    throw err;
  }
  // Screen BEFORE anything is stored (FILE_SCAN_POLICY, shared with every
  // ingest path). Refusals throw 422/503 AppErrors and nothing is written.
  await screenUploadBuffer(file.buffer, {
    subject: 'Profile photo',
    context: { tenantId, route: 'patient-profile-photo' },
  });
  const storageKey = [
    'patient-profile-photos',
    tenantId,
    `${Date.now()}_${crypto.randomUUID()}.${imageExtension(mimeType)}`,
  ].join('/');
  return uploadFileToR2(file.buffer, storageKey, mimeType);
}

function attachPatientPhiContext(req, patient, extra = {}) {
  if (!patient) return;
  req.phiContext = {
    ...(req.phiContext || {}),
    patientId: patient.id ?? null,
    patient_id: patient.id ?? null,
    patientUid: patient.uid ?? null,
    patient_uid: patient.uid ?? null,
    ...extra,
  };
}

async function fetchPatientByUid(uid, tenantId) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT u.id, u.uid, u.name, u.phone, u.gender, u.birthday, u.address,
            u.abha_address, u.profile_picture,
            COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
            CASE WHEN u.birthday IS NOT NULL
                 THEN DATE_PART('year', AGE(u.birthday))::int
            END AS age
       FROM users u
       LEFT JOIN LATERAL (
         SELECT pi.identifier_value
           FROM patient_identifiers pi
          WHERE pi.tenant_id = u.tenant_id
            AND pi.patient_uid = u.uid
            AND pi.identifier_type IN ('mrn', 'uhid')
            AND pi.status = 'active'
          ORDER BY pi.is_primary DESC,
                   CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                   pi.created_at ASC
          LIMIT 1
       ) hn ON TRUE
      WHERE u.uid = $1::uuid
        AND u.tenant_id = $2::uuid
        AND u.role = 'PATIENT'
        AND u.is_active = true
      LIMIT 1`,
    uid,
    tenantId,
  );
  return rows[0] || null;
}

export const searchPatients = async (req, res) => {
  try {
    const raw = (req.query.q ?? req.query.query ?? '').toString().trim();
    if (raw.length < MIN_QUERY_LENGTH) {
      // Return empty list rather than 400 — UI debounces, may fire with
      // a 1-char query while the user is still typing.
      return success(res, { patients: [], count: 0 }, 'Patient search results');
    }
    const q = raw.toLowerCase();
    const tenantIdForUid = UUID_QUERY_RE.test(raw) ? tenantOf(req) : null;
    if (tenantIdForUid) {
      // Exact wristband-UID resolution (STF-4). Same row shape as the text
      // search; tenant-scoped like every other branch here. The uid is not
      // matched by the LIKE branches below, so return directly.
      const rows = await prisma.$queryRawUnsafe(
        `SELECT u.id, u.uid, u.name, u.phone, u.gender, u.abha_address,
                u.profile_picture,
                COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
                CASE WHEN u.birthday IS NOT NULL
                     THEN DATE_PART('year', AGE(u.birthday))::int
                END AS age
           FROM users u
           LEFT JOIN LATERAL (
             SELECT pi.identifier_value
               FROM patient_identifiers pi
              WHERE pi.tenant_id = u.tenant_id
                AND pi.patient_uid = u.uid
                AND pi.identifier_type IN ('mrn', 'uhid')
                AND pi.status = 'active'
              ORDER BY pi.is_primary DESC,
                       CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                       pi.created_at ASC
              LIMIT 1
           ) hn ON TRUE
          WHERE u.role = 'PATIENT'
            AND u.is_active = true
            AND LOWER(BTRIM(COALESCE(u.status, ''))) = 'active'
            AND u.is_deleted IS FALSE
            AND u.deleted_at IS NULL
            AND u.merged_into_uid IS NULL
            AND u.uid = $1::uuid
            AND u.tenant_id = $2::uuid
          LIMIT 1`,
        raw.toLowerCase(),
        tenantIdForUid,
      );
      return success(
        res,
        { patients: rows, count: rows.length, query: raw },
        'Patient search results',
      );
    }
    const rawDigits = raw.replace(/\D/g, '');
    const isPhoneLikeSearch = PHONE_QUERY_RE.test(raw) && rawDigits.length > 0;
    if (isPhoneLikeSearch && rawDigits.length < 10) {
      return success(res, { patients: [], count: 0, query: raw }, 'Patient search results');
    }
    const normalizedPhone = isPhoneLikeSearch ? validPatientPhone(raw) : null;
    const normalizedPhoneDigits = normalizedPhone?.replace(/\D/g, '') || rawDigits;
    const nationalPhoneDigits = normalizedPhoneDigits.startsWith('91') &&
      normalizedPhoneDigits.length === 12
      ? normalizedPhoneDigits.slice(2)
      : rawDigits;
    const limit = Math.min(
      MAX_RESULTS,
      parseInt(req.query.limit, 10) || MAX_RESULTS,
    );
    const tenantId = tenantOf(req);

    const rows = normalizedPhone
      ? await prisma.$queryRawUnsafe(
        `SELECT u.id, u.uid, u.name, u.phone, u.gender, u.abha_address,
                u.profile_picture,
                COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
                CASE WHEN u.birthday IS NOT NULL
                     THEN DATE_PART('year', AGE(u.birthday))::int
                END AS age
           FROM users u
           LEFT JOIN LATERAL (
             SELECT pi.identifier_value
               FROM patient_identifiers pi
              WHERE pi.tenant_id = u.tenant_id
                AND pi.patient_uid = u.uid
                AND pi.identifier_type IN ('mrn', 'uhid')
                AND pi.status = 'active'
              ORDER BY pi.is_primary DESC,
                       CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                       pi.created_at ASC
              LIMIT 1
           ) hn ON TRUE
          WHERE u.role = 'PATIENT'
            AND u.is_active = true
            AND u.tenant_id = $4::uuid
            AND (
              u.phone = $1
              OR REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = $2
              OR REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = $3
            )
          ORDER BY
            CASE
              WHEN u.phone = $1 THEN 0
              WHEN REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = $2 THEN 1
              WHEN REGEXP_REPLACE(COALESCE(u.phone, ''), '\\D', '', 'g') = $3 THEN 2
              ELSE 3
            END,
            u.name ASC
          LIMIT $5`,
        normalizedPhone,
        normalizedPhoneDigits,
        nationalPhoneDigits,
        tenantId,
        limit,
      )
      : await prisma.$queryRawUnsafe(
      `SELECT u.id, u.uid, u.name, u.phone, u.gender, u.abha_address,
              u.profile_picture,
              COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0')) AS hospital_number,
              CASE WHEN u.birthday IS NOT NULL
                   THEN DATE_PART('year', AGE(u.birthday))::int
              END AS age
         FROM users u
         LEFT JOIN LATERAL (
           SELECT pi.identifier_value
             FROM patient_identifiers pi
            WHERE pi.tenant_id = u.tenant_id
              AND pi.patient_uid = u.uid
              AND pi.identifier_type IN ('mrn', 'uhid')
              AND pi.status = 'active'
            ORDER BY pi.is_primary DESC,
                     CASE pi.identifier_type WHEN 'mrn' THEN 0 WHEN 'uhid' THEN 1 ELSE 2 END,
                     pi.created_at ASC
            LIMIT 1
         ) hn ON TRUE
        WHERE u.role = 'PATIENT'
          AND u.is_active = true
          AND u.tenant_id = $4::uuid
          AND (
            LOWER(COALESCE(u.name, '')) LIKE $1
            OR LOWER(COALESCE(u.phone, '')) LIKE $1
            OR LOWER(COALESCE(u.abha_address, '')) LIKE $1
            OR LOWER(COALESCE(hn.identifier_value, '')) LIKE $1
            OR LOWER('VH-' || LPAD(u.id::text, 6, '0')) LIKE $1
          )
        ORDER BY
          CASE WHEN LOWER(COALESCE(hn.identifier_value, 'VH-' || LPAD(u.id::text, 6, '0'))) = $5 THEN 0 ELSE 1 END,
          CASE WHEN LOWER(COALESCE(u.name, '')) LIKE $2 THEN 0 ELSE 1 END,
          u.name ASC
        LIMIT $3`,
      `%${q}%`, `${q}%`, limit, tenantId, q,
      );

    success(
      res,
      { patients: rows, count: rows.length, query: raw },
      'Patient search results',
    );
  } catch (err) {
    logger.error('Patient search error:', err);
    error(res, 'Patient search failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const createPatient = async (req, res) => {
  try {
    const name = String(req.body.name ?? req.body.patient_name ?? '').trim();
    const phone = validPatientPhone(req.body.phone ?? req.body.patient_phone);
    if (!name) {
      return error(res, 'Patient name is required', HTTP_STATUS.BAD_REQUEST);
    }
    if (!phone) {
      return error(res, 'Valid patient phone is required', HTTP_STATUS.BAD_REQUEST);
    }

    const tenantId = tenantOf(req);
    const last10 = phone.replace(/\D/g, '').slice(-10);
    const exactPhoneRows = await prisma.$queryRawUnsafe(
      `SELECT id, uid, phone, name, role
         FROM users
        WHERE tenant_id = $1::uuid
          AND (phone = $2 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $3)
        ORDER BY CASE WHEN phone = $2 THEN 0 ELSE 1 END, registered_at DESC NULLS LAST
        LIMIT 1`,
      tenantId,
      phone,
      `%${last10}`,
    );

    if (exactPhoneRows.length > 0) {
      if (exactPhoneRows[0].role !== 'PATIENT') {
        return error(
          res,
          'This phone number belongs to a non-patient account',
          HTTP_STATUS.CONFLICT,
        );
      }
      const existingPatient = await fetchPatientByUid(exactPhoneRows[0].uid, tenantId);
      return duplicateReviewResponse(res, [
        {
          ...publicPatient(existingPatient ?? exactPhoneRows[0]),
          confidence_score: 92,
          confidence_band: 'high',
          match_signals: { phone_last10: true },
        },
      ]);
    }

    const gender = normalizeGender(req.body.gender ?? req.body.patient_gender);
    const birthday = normalizeBirthday(req.body.birthday ?? req.body.patient_birthday);
    const address = String(req.body.address ?? req.body.patient_address ?? '').trim();
    const abhaAddress = String(req.body.abha_address ?? req.body.abhaAddress ?? '').trim();
    const overrideReason = duplicateOverrideReason(req.body);
    const duplicateScan = await findRegistrationDuplicateCandidates({
      tenantId,
      name,
      phone,
      birthday,
      abhaAddress,
    });
    if (duplicateScan.candidates.length > 0 &&
        overrideReason.length < DUPLICATE_OVERRIDE_MIN_REASON) {
      return duplicateReviewResponse(res, duplicateScan.candidates);
    }

    let profilePicture = null;
    try {
      profilePicture = await uploadPatientProfilePhoto({ file: req.file, tenantId });
    } catch (photoErr) {
      return error(
        res,
        photoErr.message || 'Patient profile photo upload failed',
        photoErr.statusCode || HTTP_STATUS.BAD_REQUEST,
      );
    }

    // Tenant-scoped on purpose. A bare `prisma.$transaction` hands back the raw
    // itx client, which skips the prisma proxy's tenant wrapper, so
    // `app.current_tenant_id` stays unset inside it. `public.users` carries the
    // RESTRICTIVE `explicit_tenant_context_753` policy (migration 758) whose
    // WITH CHECK requires that GUC — naming tenant_id in the INSERT is not
    // enough, the unscoped write is rejected 42501.
    const rows = await setTenantTx(tenantId, async (tx) => {
      const inserted = await tx.$queryRawUnsafe(
        `INSERT INTO users
           (phone, name, gender, birthday, address, profile_picture, role, is_active, tenant_id, registered_at, updated_at)
         VALUES ($1, $2, $3, $4::date, $5, $6, 'PATIENT', true, $7::uuid, NOW(), NOW())
         RETURNING id, uid`,
        phone,
        name,
        gender,
        birthday,
        address || null,
        profilePicture,
        tenantId,
      );
      return withAuthIdentityLifecycleLocks(tx, [inserted[0].uid], async () => inserted);
    });

    const patient = await fetchPatientByUid(rows[0].uid, tenantId);
    attachPatientPhiContext(req, patient ?? rows[0], {
      source: 'staff_patient_registry',
      front_office_action: 'create_patient',
    });
    await logAudit(req, 'FRONT_OFFICE_PATIENT_CREATED', {
      patient_id: patient?.id ?? rows[0].id,
      patient_uid: patient?.uid ?? rows[0].uid,
      hospital_number: patient?.hospital_number ?? null,
      source: 'staff_patient_search',
      duplicate_override_reason: overrideReason || null,
      duplicate_candidate_count: duplicateScan.candidates.length,
      profile_photo_attached: Boolean(profilePicture),
    }, {
      resource: 'patient',
      resourceId: patient?.uid ?? rows[0].uid,
    });
    if (duplicateScan.candidates.length > 0) {
      await recordRegistrationDuplicateOverride({
        tenantId,
        newPatientUid: rows[0].uid,
        candidates: duplicateScan.candidates,
        decidedBy: req.user?.uid ?? null,
        reason: overrideReason,
      });
      await logAudit(req, 'FRONT_OFFICE_PATIENT_DUPLICATE_OVERRIDE', {
        patient_id: patient?.id ?? rows[0].id,
        patient_uid: patient?.uid ?? rows[0].uid,
        reason: overrideReason,
        candidate_count: duplicateScan.candidates.length,
        candidates: duplicateScan.candidates.map((candidate) => ({
          uid: candidate.uid,
          confidence_score: candidate.confidence_score,
          confidence_band: candidate.confidence_band,
          match_signals: candidate.match_signals,
        })),
      }, {
        resource: 'patient',
        resourceId: patient?.uid ?? rows[0].uid,
      });
    }
    return success(res, { patient: publicPatient(patient) }, 'Patient created', HTTP_STATUS.CREATED);
  } catch (err) {
    logger.error('Patient create error:', err);
    return error(res, 'Patient creation failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const updatePatient = async (req, res) => {
  try {
    const uid = String(req.params.uid ?? '').trim();
    const tenantId = tenantOf(req);
    const existing = await fetchPatientByUid(uid, tenantId);
    if (!existing) {
      return error(res, 'Patient not found', HTTP_STATUS.NOT_FOUND);
    }
    attachPatientPhiContext(req, existing, {
      source: 'staff_patient_registry',
      front_office_action: 'update_patient',
    });

    const updates = [];
    const values = [];
    const add = (column, value, cast = '') => {
      values.push(value);
      updates.push(`${column} = $${values.length}${cast}`);
    };

    if (Object.prototype.hasOwnProperty.call(req.body, 'name') ||
        Object.prototype.hasOwnProperty.call(req.body, 'patient_name')) {
      const name = String(req.body.name ?? req.body.patient_name ?? '').trim();
      if (!name) return error(res, 'Patient name is required', HTTP_STATUS.BAD_REQUEST);
      add('name', name);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'phone') ||
        Object.prototype.hasOwnProperty.call(req.body, 'patient_phone')) {
      const phone = validPatientPhone(req.body.phone ?? req.body.patient_phone);
      if (!phone) return error(res, 'Valid patient phone is required', HTTP_STATUS.BAD_REQUEST);
      const last10 = phone.replace(/\D/g, '').slice(-10);
      const duplicate = await prisma.$queryRawUnsafe(
        `SELECT uid, role
           FROM users
          WHERE tenant_id = $1::uuid
            AND uid <> $2::uuid
            AND (phone = $3 OR REGEXP_REPLACE(COALESCE(phone, ''), '\\D', '', 'g') LIKE $4)
          LIMIT 1`,
        tenantId,
        uid,
        phone,
        `%${last10}`,
      );
      if (duplicate.length > 0) {
        return error(res, 'Phone number is already used by another account', HTTP_STATUS.CONFLICT);
      }
      add('phone', phone);
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'gender') ||
        Object.prototype.hasOwnProperty.call(req.body, 'patient_gender')) {
      add('gender', normalizeGender(req.body.gender ?? req.body.patient_gender));
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'birthday') ||
        Object.prototype.hasOwnProperty.call(req.body, 'patient_birthday')) {
      add('birthday', normalizeBirthday(req.body.birthday ?? req.body.patient_birthday), '::date');
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'address') ||
        Object.prototype.hasOwnProperty.call(req.body, 'patient_address')) {
      const address = String(req.body.address ?? req.body.patient_address ?? '').trim();
      add('address', address || null);
    }

    if (updates.length === 0) {
      return success(res, { patient: publicPatient(existing) }, 'Patient unchanged');
    }

    values.push(uid, tenantId);
    await prisma.$queryRawUnsafe(
      `UPDATE users
          SET ${updates.join(', ')}, updated_at = NOW()
        WHERE uid = $${values.length - 1}::uuid
          AND tenant_id = $${values.length}::uuid
          AND role = 'PATIENT'`,
      ...values,
    );

    const patient = await fetchPatientByUid(uid, tenantId);
    attachPatientPhiContext(req, patient ?? existing, {
      source: 'staff_patient_registry',
      front_office_action: 'update_patient',
      changed_fields: updates.map((entry) => String(entry).split(' = ')[0]),
    });
    await logAudit(req, 'FRONT_OFFICE_PATIENT_UPDATED', {
      patient_id: patient?.id ?? existing.id,
      patient_uid: uid,
      hospital_number: patient?.hospital_number ?? existing.hospital_number ?? null,
      changed_fields: updates.map((entry) => String(entry).split(' = ')[0]),
      source: 'staff_patient_search',
    }, {
      resource: 'patient',
      resourceId: uid,
    });
    return success(res, { patient: publicPatient(patient) }, 'Patient updated');
  } catch (err) {
    logger.error('Patient update error:', err);
    return error(res, 'Patient update failed', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
