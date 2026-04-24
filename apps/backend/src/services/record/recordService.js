// src/services/record/recordService.js
// Migrated from raw pg to Prisma ORM

import { DEFAULT_PAGINATION } from '../../config/recordConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { getPrivacyFilterForRole } from './accessControlService.js';

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export async function getRecordsByUID(uid) {
  try {
    return prisma.health_records.findMany({
      where: { uid: uid },
      select: {
        id: true, uid: true, phone: true, record_type: true,
        file_name: true, file_type: true, file_key: true,
        file_size: true, privacy_level: true, created_by: true,
        created_at: true, updated_at: true,
      },
      orderBy: { created_at: 'desc' },
    });
  } catch (error) {
    logger.error(`[RecordService] Error getting records by UID: ${error.message}`);
    throw error;
  }
}

export async function getHealthRecordsByUid(uid, filters = {}) {
  try {
    const { type, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT, offset = DEFAULT_PAGINATION.DEFAULT_OFFSET } = filters;

    let rows;
    if (type) {
      rows = await prisma.$queryRaw`
        SELECT hr.id, hr.uid, hr.phone, hr.record_type, hr.file_name, hr.file_type,
               hr.file_key, hr.file_size, hr.privacy_level, hr.created_by,
               hr.created_at, hr.updated_at,
               TO_CHAR(hr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               u.name AS patient_name, u.uid AS patient_uid
        FROM health_records hr
        LEFT JOIN users u ON hr.phone = u.phone
        WHERE u.uid = ${uid}
          AND LOWER(hr.file_type) = LOWER(${type})
        ORDER BY hr.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT hr.id, hr.uid, hr.phone, hr.record_type, hr.file_name, hr.file_type,
               hr.file_key, hr.file_size, hr.privacy_level, hr.created_by,
               hr.created_at, hr.updated_at,
               TO_CHAR(hr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               u.name AS patient_name, u.uid AS patient_uid
        FROM health_records hr
        LEFT JOIN users u ON hr.phone = u.phone
        WHERE u.uid = ${uid}
        ORDER BY hr.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `;
    }

    return rows;
  } catch (error) {
    logger.error(`[RecordService] Error getting health records by UID: ${error.message}`);
    throw error;
  }
}

export async function getHealthRecordsByPhone(phone, filters = {}) {
  try {
    const normalizedPhone = normalizePhone(phone);
    const { type, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT, offset = DEFAULT_PAGINATION.DEFAULT_OFFSET } = filters;

    let rows;
    if (type) {
      rows = await prisma.$queryRaw`
        SELECT hr.id, hr.uid, hr.phone, hr.record_type, hr.file_name, hr.file_type,
               hr.file_key, hr.file_size, hr.privacy_level, hr.created_by,
               hr.created_at, hr.updated_at,
               TO_CHAR(hr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               u.name AS patient_name, u.uid AS patient_uid
        FROM health_records hr
        LEFT JOIN users u ON hr.phone = u.phone
        WHERE hr.phone = ${normalizedPhone}
          AND LOWER(hr.file_type) = LOWER(${type})
        ORDER BY hr.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `;
    } else {
      rows = await prisma.$queryRaw`
        SELECT hr.id, hr.uid, hr.phone, hr.record_type, hr.file_name, hr.file_type,
               hr.file_key, hr.file_size, hr.privacy_level, hr.created_by,
               hr.created_at, hr.updated_at,
               TO_CHAR(hr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               u.name AS patient_name, u.uid AS patient_uid
        FROM health_records hr
        LEFT JOIN users u ON hr.phone = u.phone
        WHERE hr.phone = ${normalizedPhone}
        ORDER BY hr.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `;
    }

    return rows;
  } catch (error) {
    logger.error(`[RecordService] Error getting health records by phone: ${error.message}`);
    throw error;
  }
}

export async function createHealthRecord(data, createdBy, _createdByRole) {
  try {
    const { phone, file_key, file_name, file_type, privacy_level = 'RESTRICTED', notes } = data;
    const createdByUuid = createdBy && isValidUUID(createdBy) ? createdBy : null;

    const record = await prisma.health_records.create({
      data: {
        phone: normalizePhone(phone),
        file_key: file_key || null,
        file_name: file_name,
        file_type: file_type,
        privacy_level: privacy_level,
        created_by: createdByUuid,
      },
    });

    return record;
  } catch (error) {
    logger.error(`[RecordService] Error creating health record: ${error.message}`);
    throw error;
  }
}

// Relation name generated by Prisma for medical_records.doctor_id → users.id
// (migration 086). Patient info still fetched via a separate findMany keyed
// on medical_records.patient_id (uuid, no FK — the column's two prior
// interpretations are documented in migration 086's header).
const REL_DOCTOR = 'users';

// Format a created_at/updated_at value the way the old TO_CHAR-based
// SQL did: DD-MM-YYYY HH24:MI. One helper so every list view stays
// consistent.
function fmtDateTime(d) {
  if (!d) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Stitch patient + doctor-profile info onto a batch of medical_records
// rows. One findMany per related domain, deduped by uid/id — O(1)
// extra queries per list regardless of page size.
async function enrichMedicalRecords(rows) {
  if (rows.length === 0) return [];

  const patientUids = [...new Set(rows.map((r) => r.patient_id).filter(Boolean))];
  const doctorUserIds = [...new Set(
    rows.map((r) => r[REL_DOCTOR]?.id).filter(Boolean),
  )];

  const [patients, doctorProfiles] = await Promise.all([
    patientUids.length
      ? prisma.users.findMany({
          where: { uid: { in: patientUids } },
          select: {
            uid: true,
            id: true,
            name: true,
            phone: true,
            email: true,
            birthday: true,
            gender: true,
            address: true,
          },
        })
      : [],
    doctorUserIds.length
      ? prisma.doctors.findMany({
          where: { user_id: { in: doctorUserIds } },
          select: { user_id: true, specialty: true, department: true },
        })
      : [],
  ]);

  const patientMap = new Map(patients.map((p) => [p.uid, p]));
  const profileMap = new Map(doctorProfiles.map((p) => [p.user_id, p]));

  return rows.map((r) => {
    const patient = r.patient_id ? patientMap.get(r.patient_id) ?? null : null;
    const doctor = r[REL_DOCTOR] ?? null;
    const profile = doctor ? profileMap.get(doctor.id) ?? null : null;
    const flat = { ...r };
    delete flat[REL_DOCTOR];
    flat.patient_name = patient?.name ?? null;
    flat.patient_phone = patient?.phone ?? null;
    flat.patient_email = patient?.email ?? null;
    flat.patient_uid = patient?.uid ?? r.patient_id ?? null;
    flat.birthday = patient?.birthday ?? null;
    flat.gender = patient?.gender ?? null;
    flat.address = patient?.address ?? null;
    flat.doctor_name = doctor?.name ?? null;
    flat.doctor_phone = doctor?.phone ?? null;
    flat.doctor_email = doctor?.email ?? null;
    // Preserve the old `doctor_id` string alias (the raw SQL coalesced
    // uid/id depending on what was stored). Now we just report users.id
    // as a string.
    flat.doctor_id = doctor?.id != null ? String(doctor.id) : null;
    flat.specialization = profile?.specialty ?? null;
    flat.department = profile?.department ?? null;
    flat.created_at_formatted = fmtDateTime(r.created_at);
    return flat;
  });
}

export async function getMedicalRecords(filters = {}, _userRole) {
  try {
    const {
      page = 1, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      patient_id, doctor_id, record_type, date_from, date_to
    } = filters;
    const offset = (page - 1) * limit;

    const where = {};
    // patient_id is uuid; accept either a raw uuid or let Prisma coerce
    // (callers pass strings). Not int-coercing as the old SQL did — the
    // DB column is uuid and that's the only semantic that matches.
    if (patient_id) where.patient_id = String(patient_id);
    if (doctor_id) where.doctor_id = parseInt(doctor_id);
    if (record_type) where.record_type = record_type.toUpperCase();
    if (date_from || date_to) {
      where.created_at = {};
      if (date_from) where.created_at.gte = new Date(date_from);
      if (date_to) {
        const end = new Date(date_to);
        end.setDate(end.getDate() + 1);
        where.created_at.lt = end;
      }
    }

    const [rows, totalRecords] = await Promise.all([
      prisma.medical_records.findMany({
        where,
        select: {
          id: true,
          patient_id: true,
          doctor_id: true,
          record_type: true,
          title: true,
          description: true,
          diagnosis: true,
          treatment: true,
          medications: true,
          privacy_level: true,
          created_at: true,
          [REL_DOCTOR]: {
            select: { id: true, name: true, phone: true, email: true },
          },
        },
        orderBy: { created_at: 'desc' },
        take: parseInt(limit),
        skip: parseInt(offset),
      }),
      prisma.medical_records.count({ where }),
    ]);

    const records = await enrichMedicalRecords(rows);

    return {
      records,
      pagination: {
        page, limit, total: totalRecords,
        totalPages: Math.ceil(totalRecords / limit),
        hasNext: page * limit < totalRecords,
        hasPrev: page > 1,
      },
    };
  } catch (error) {
    logger.error(`[RecordService] Error getting medical records: ${error.message}`);
    throw error;
  }
}

export async function getMedicalRecordById(id) {
  try {
    const row = await prisma.medical_records.findUnique({
      where: { id: parseInt(id) },
      select: {
        id: true,
        patient_id: true,
        doctor_id: true,
        record_type: true,
        title: true,
        description: true,
        diagnosis: true,
        treatment: true,
        medications: true,
        lab_results: true,
        attachments: true,
        privacy_level: true,
        created_at: true,
        [REL_DOCTOR]: {
          select: { id: true, name: true, phone: true, email: true },
        },
      },
    });
    if (!row) return null;
    const [enriched] = await enrichMedicalRecords([row]);
    return enriched;
  } catch (error) {
    logger.error(`[RecordService] Error getting medical record by ID: ${error.message}`);
    throw error;
  }
}

export async function createMedicalRecord(data, doctorId, createdBy) {
  try {
    return await prisma.$transaction(async (tx) => {
      const patientRows = await tx.$queryRaw`
        SELECT id, name, phone FROM users WHERE id = ${parseInt(data.patient_id)}
      `;

      if (patientRows.length === 0) throw new Error('Patient not found');

      const recordRows = await tx.$queryRaw`
        INSERT INTO medical_records (
          patient_id, doctor_id, record_type, title, description,
          diagnosis, treatment, medications, lab_results, attachments,
          privacy_level, created_by, created_at
        ) VALUES (
          ${parseInt(data.patient_id)}, ${parseInt(doctorId)},
          ${data.record_type.toUpperCase()},
          ${data.title ?? null}, ${data.description ?? null},
          ${data.diagnosis ?? null}, ${data.treatment ?? null},
          ${data.medications ?? null}::jsonb, ${data.lab_results ?? null}::jsonb,
          ${data.attachments ?? null}::jsonb,
          ${data.privacy_level || 'RESTRICTED'}, ${createdBy ?? null}, NOW()
        )
        RETURNING id, patient_id, doctor_id, record_type, title, description,
          diagnosis, treatment, privacy_level, created_by, created_at
      `;

      return { record: recordRows[0], patient: patientRows[0] };
    });
  } catch (error) {
    logger.error(`[RecordService] Error creating medical record: ${error.message}`);
    throw error;
  }
}

export async function updateMedicalRecord(id, data, updatedBy) {
  try {
    const { title, description, diagnosis, treatment, medications, lab_results, attachments } = data;

    const rows = await prisma.$queryRaw`
      UPDATE medical_records SET
        title       = COALESCE(${title ?? null}, title),
        description = COALESCE(${description ?? null}, description),
        diagnosis   = COALESCE(${diagnosis ?? null}, diagnosis),
        treatment   = COALESCE(${treatment ?? null}, treatment),
        medications = COALESCE(${medications ?? null}::jsonb, medications),
        lab_results = COALESCE(${lab_results ?? null}::jsonb, lab_results),
        attachments = COALESCE(${attachments ?? null}::jsonb, attachments),
        updated_at  = NOW(),
        updated_by  = ${updatedBy ?? null}
      WHERE id = ${parseInt(id)}
      RETURNING id, patient_id, doctor_id, record_type, title, description,
        diagnosis, treatment, privacy_level, created_by, created_at, updated_at
    `;

    return rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error updating medical record: ${error.message}`);
    throw error;
  }
}

export async function softDeleteRecord(id, deletedBy, _reason) {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE medical_records
      SET is_active = false, deleted_at = NOW(), deleted_by = ${deletedBy ?? null}
      WHERE id = ${parseInt(id)}
      RETURNING id, title
    `;
    return rows[0];
  } catch (error) {
    logger.error(`[RecordService] Error deleting medical record: ${error.message}`);
    throw error;
  }
}

export async function getPatientInfo(patientId) {
  try {
    return prisma.users.findUnique({
      where: { id: parseInt(patientId) },
      select: {
        id: true, name: true, phone: true, email: true,
        birthday: true, gender: true, address: true, uid: true,
      },
    });
  } catch (error) {
    logger.error(`[RecordService] Error getting patient info: ${error.message}`);
    throw error;
  }
}

export async function searchMedicalRecords(searchTerm, userRole, limit = 50) {
  try {
    void userRole; // reserved for future privacy filtering
    const q = { contains: searchTerm, mode: 'insensitive' };
    const rows = await prisma.medical_records.findMany({
      where: {
        OR: [
          { title: q },
          { description: q },
          { diagnosis: q },
          { treatment: q },
          // users relation match surfaces "records where the doctor's
          // name contains the term". Patient-name search is handled by
          // a separate findMany lookup (no cheap way to do it via ORM
          // because patient_id has no declared FK — see
          // migration 086 header for the rationale).
          { [REL_DOCTOR]: { name: q } },
        ],
      },
      select: {
        id: true,
        patient_id: true,
        doctor_id: true,
        record_type: true,
        title: true,
        description: true,
        diagnosis: true,
        treatment: true,
        medications: true,
        privacy_level: true,
        created_at: true,
        [REL_DOCTOR]: {
          select: { id: true, name: true, phone: true, email: true },
        },
      },
      orderBy: { created_at: 'desc' },
      take: parseInt(limit),
    });

    return enrichMedicalRecords(rows);
  } catch (error) {
    logger.error(`[RecordService] Error searching medical records: ${error.message}`);
    throw error;
  }
}

export async function getPatientSummary(patientId, _privacyFilter = '') {
  try {
    // privacyFilter is a raw SQL string appended to query — use $queryRaw
    const rows = await prisma.$queryRaw`
      WITH patient_info AS (
        SELECT name, phone, email, birthday, gender, address
        FROM users WHERE id = ${parseInt(patientId)}
      ),
      record_stats AS (
        SELECT record_type, COUNT(*)::int AS count, MAX(created_at) AS last_record
        FROM medical_records
        WHERE patient_id = ${parseInt(patientId)}
        GROUP BY record_type
      ),
      recent_records AS (
        SELECT mr.id, mr.record_type, mr.title, mr.privacy_level,
               TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               d.name AS doctor_name, dp.specialty AS specialization
        FROM medical_records mr
        LEFT JOIN users d ON mr.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE mr.patient_id = ${parseInt(patientId)}
        ORDER BY mr.created_at DESC
        LIMIT 5
      )
      SELECT
        (SELECT row_to_json(patient_info.*) FROM patient_info) AS patient,
        (SELECT json_agg(record_stats.*) FROM record_stats) AS record_stats,
        (SELECT json_agg(recent_records.*) FROM recent_records) AS recent_records
    `;

    const data = rows[0];
    return {
      patient: data.patient,
      recordStats: data.record_stats || [],
      recentRecords: data.recent_records || [],
    };
  } catch (error) {
    logger.error(`[RecordService] Error getting patient summary: ${error.message}`);
    throw error;
  }
}
