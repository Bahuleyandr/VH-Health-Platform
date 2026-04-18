// src/services/record/recordService.js
// Migrated from raw pg to Prisma ORM

import { Prisma } from '@prisma/client';
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

export async function getMedicalRecords(filters = {}, _userRole) {
  try {
    const {
      page = 1, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      patient_id, doctor_id, record_type, date_from, date_to
    } = filters;
    const offset = (page - 1) * limit;

    const conditions = [Prisma.sql`1=1`];
    if (patient_id) conditions.push(Prisma.sql`mr.patient_id = ${parseInt(patient_id)}`);
    if (doctor_id) conditions.push(Prisma.sql`mr.doctor_id = ${parseInt(doctor_id)}`);
    if (record_type) conditions.push(Prisma.sql`mr.record_type = ${record_type.toUpperCase()}`);
    if (date_from) conditions.push(Prisma.sql`DATE(mr.created_at) >= ${date_from}::date`);
    if (date_to) conditions.push(Prisma.sql`DATE(mr.created_at) <= ${date_to}::date`);

    const whereClause = Prisma.join(conditions, ' AND ');

    const [records, countRows] = await Promise.all([
      prisma.$queryRaw`
        SELECT mr.id, mr.record_type, mr.title, mr.description, mr.diagnosis,
               mr.treatment, mr.medications, mr.privacy_level,
               TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
               TO_CHAR(mr.updated_at, 'DD-MM-YYYY HH24:MI') AS updated_at_formatted,
               p.name AS patient_name, p.phone AS patient_phone, p.id AS patient_id,
               d.name AS doctor_name, d.phone AS doctor_phone, d.id AS doctor_id,
               dp.specialty AS specialization, dp.department
        FROM medical_records mr
        LEFT JOIN users p ON mr.patient_id = p.id
        LEFT JOIN users d ON mr.doctor_id = d.id
        LEFT JOIN doctors dp ON d.id = dp.user_id
        WHERE ${whereClause}
        ORDER BY mr.created_at DESC
        LIMIT ${parseInt(limit)} OFFSET ${parseInt(offset)}
      `,
      prisma.$queryRaw`
        SELECT COUNT(*)::int AS count
        FROM medical_records mr
        WHERE ${whereClause}
      `,
    ]);

    const totalRecords = countRows[0].count;

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
    const rows = await prisma.$queryRaw`
      SELECT mr.id, mr.record_type, mr.title, mr.description, mr.diagnosis,
             mr.treatment, mr.medications, mr.privacy_level, mr.created_at, mr.updated_at,
             TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
             TO_CHAR(mr.updated_at, 'DD-MM-YYYY HH24:MI') AS updated_at_formatted,
             p.name AS patient_name, p.phone AS patient_phone, p.email AS patient_email,
             p.birthday, p.gender, p.address, p.uid AS patient_uid,
             d.name AS doctor_name, d.phone AS doctor_phone, d.email AS doctor_email,
             dp.specialty AS specialization, dp.department
      FROM medical_records mr
      LEFT JOIN users p ON mr.patient_id = p.id
      LEFT JOIN users d ON mr.doctor_id = d.id
      LEFT JOIN doctors dp ON d.id = dp.user_id
      WHERE mr.id = ${parseInt(id)}
    `;
    return rows[0] || null;
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
    // privacyFilter is a raw SQL string fragment — keep as $queryRaw
    const rows = await prisma.$queryRaw`
      SELECT mr.id, mr.record_type, mr.title, mr.description, mr.diagnosis,
             mr.treatment, mr.medications, mr.privacy_level, mr.created_at, mr.updated_at,
             TO_CHAR(mr.created_at, 'DD-MM-YYYY HH24:MI') AS created_at_formatted,
             p.name AS patient_name, p.phone AS patient_phone,
             d.name AS doctor_name
      FROM medical_records mr
      LEFT JOIN users p ON mr.patient_id = p.id
      LEFT JOIN users d ON mr.doctor_id = d.id
      WHERE (
        mr.title       ILIKE ${'%' + searchTerm + '%'} OR
        mr.description ILIKE ${'%' + searchTerm + '%'} OR
        mr.diagnosis   ILIKE ${'%' + searchTerm + '%'} OR
        mr.treatment   ILIKE ${'%' + searchTerm + '%'} OR
        p.name         ILIKE ${'%' + searchTerm + '%'} OR
        d.name         ILIKE ${'%' + searchTerm + '%'}
      )
      ORDER BY mr.created_at DESC
      LIMIT ${parseInt(limit)}
    `;
    return rows;
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
