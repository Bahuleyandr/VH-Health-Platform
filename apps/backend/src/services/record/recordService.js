// src/services/record/recordService.js
// Migrated from raw pg to Prisma ORM

import { DEFAULT_PAGINATION } from '../../config/recordConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { buildPagination } from '../../utils/listQuery.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { encryptColumn } from '../security/phiColumnEncryption.js';
import { DEFAULT_TENANT_ID } from '../tenant/tenantService.js';

function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

/**
 * Phase E3 follow-up — best-effort write of medical_records *_encrypted
 * shadow columns. Raw UPDATE because the Prisma client doesn't model
 * the shadow columns from migration 132 yet. Schema-missing degrades
 * silently. `client` is either prisma or the active transaction (tx).
 */
async function writeRecordPhiShadows(client, recordId, fields) {
  if (!recordId) return;
  const sets = [];
  const params = [];
  const tryEncrypt = (column, val) => {
    if (val === undefined) return;
    try {
      const enc = encryptColumn(val);
      params.push(enc);
      sets.push(`${column} = $${params.length}`);
    } catch (err) {
      logger.warn('medical_records PHI shadow encrypt skipped:', { column, error: err.message });
    }
  };
  tryEncrypt('description_encrypted', fields.description);
  tryEncrypt('diagnosis_encrypted', fields.diagnosis);
  tryEncrypt('treatment_encrypted', fields.treatment);
  if (sets.length === 0) return;
  params.push(recordId);
  try {
    await client.$executeRawUnsafe(
      `UPDATE medical_records SET ${sets.join(', ')} WHERE id = $${params.length}`,
      ...params,
    );
  } catch (err) {
    if (!/does not exist/i.test(String(err.message))) {
      logger.warn('medical_records PHI shadow write failed:', { error: err.message });
    }
  }
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
        WHERE u.uid = ${uid}::uuid
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
        WHERE u.uid = ${uid}::uuid
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
    const { phone, file_key, file_name, file_type, privacy_level = 'RESTRICTED' } = data;
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
const REL_DOCTOR = 'users_medical_records_doctor_idTousers';

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

// Accept a patient_id filter either as a UUID or as a numeric
// users.id and resolve to users.uid before filtering. The API
// validator currently enforces isInt, but the DB column is uuid —
// one of these has to bridge. See batch 46's header comment for
// why we bridge in the service layer (smallest blast radius).
async function resolvePatientFilterToUuid(raw) {
  if (!raw) return null;
  const s = String(raw);
  // UUID v1-5 shape: 8-4-4-4-12 hex chars.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) {
    return s;
  }
  const asInt = parseInt(s, 10);
  if (!Number.isFinite(asInt)) return null;
  const user = await prisma.users.findUnique({
    where: { id: asInt },
    select: { uid: true },
  });
  return user?.uid ?? null;
}

export async function getMedicalRecords(filters = {}, _userRole) {
  try {
    const {
      page = 1, limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      patient_id, doctor_id, record_type, date_from, date_to
    } = filters;
    const offset = (page - 1) * limit;

    const where = { is_active: true };
    if (patient_id) {
      const patientUid = await resolvePatientFilterToUuid(patient_id);
      // Impossible-match sentinel so a bogus patient_id returns zero
      // rows instead of leaking the full set.
      where.patient_id = patientUid ?? '00000000-0000-0000-0000-000000000000';
    }
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
      pagination: buildPagination(totalRecords, page, limit),
    };
  } catch (error) {
    logger.error(`[RecordService] Error getting medical records: ${error.message}`);
    throw error;
  }
}

const PATIENT_CONSULTATION_NOTE_TYPES = ['op_consultation', 'consultation_note', 'soap'];

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function noteTextFromContent(content, fallback = '') {
  const parts = [
    content.chief_complaint ? `Chief complaint: ${content.chief_complaint}` : null,
    content.history ? `History: ${content.history}` : null,
    content.examination ? `Examination: ${content.examination}` : null,
    content.plan ? `Plan: ${content.plan}` : null,
    fallback,
  ].filter((part) => typeof part === 'string' && part.trim());
  return parts.join('\n');
}

async function getMedicalConsultationsByUid(uid, take) {
  const rows = await prisma.medical_records.findMany({
    where: {
      patient_id: String(uid),
      record_type: 'CONSULTATION',
      is_active: true,
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
      lab_results: true,
      attachments: true,
      privacy_level: true,
      created_at: true,
      updated_at: true,
      [REL_DOCTOR]: {
        select: { id: true, name: true, phone: true, email: true },
      },
    },
    orderBy: { created_at: 'desc' },
    take,
  });

  const records = await enrichMedicalRecords(rows);
  return records.map((record) => ({
    ...record,
    source: 'medical_records',
    patient_uid: record.patient_uid ?? record.patient_id,
    patient_id: record.patient_uid ?? record.patient_id,
    doctor_specialization: record.specialization ?? null,
    consultation_date:
      record.attachments?.consultationDate ??
      record.attachments?.consultation_date ??
      record.created_at,
    date: record.created_at,
    notes: record.description ?? record.treatment ?? '',
  }));
}

async function getClinicalNoteConsultationsByUid(uid, take) {
  const notes = await prisma.clinical_notes.findMany({
    where: {
      patient_uid: String(uid),
      note_type: { in: PATIENT_CONSULTATION_NOTE_TYPES },
      is_signed: true,
      status: { not: 'deleted' },
    },
    select: {
      id: true,
      patient_uid: true,
      author_uid: true,
      note_type: true,
      title: true,
      content: true,
      notes: true,
      is_signed: true,
      signed_at: true,
      created_at: true,
      updated_at: true,
      appointment_id: true,
      appointments: {
        select: {
          id: true,
          doctor_id: true,
          appointment_date: true,
          reason: true,
          users_appointments_doctor_idTousers: {
            select: { id: true, name: true, phone: true, email: true },
          },
        },
      },
    },
    orderBy: { created_at: 'desc' },
    take,
  });

  if (notes.length === 0) return [];

  const authorUids = [...new Set(notes.map((note) => note.author_uid).filter(Boolean))];
  const appointmentDoctorIds = [
    ...new Set(notes.map((note) => note.appointments?.doctor_id).filter(Boolean)),
  ];

  const [authors, doctorProfiles] = await Promise.all([
    authorUids.length
      ? prisma.users.findMany({
          where: { uid: { in: authorUids } },
          select: { uid: true, id: true, name: true, phone: true, email: true },
        })
      : [],
    appointmentDoctorIds.length
      ? prisma.doctors.findMany({
          where: { user_id: { in: appointmentDoctorIds } },
          select: { user_id: true, specialty: true, department: true },
        })
      : [],
  ]);

  const authorMap = new Map(authors.map((author) => [author.uid, author]));
  const profileMap = new Map(doctorProfiles.map((profile) => [profile.user_id, profile]));

  return notes.map((note) => {
    const content = asObject(note.content);
    const appointment = note.appointments ?? null;
    const appointmentDoctor = appointment?.users_appointments_doctor_idTousers ?? null;
    const author = note.author_uid ? authorMap.get(note.author_uid) ?? null : null;
    const doctor = appointmentDoctor ?? author;
    const doctorId = appointment?.doctor_id ?? author?.id ?? null;
    const profile = doctorId ? profileMap.get(doctorId) ?? null : null;
    const diagnosis = firstText(content.diagnosis, content.assessment);
    const notesText = noteTextFromContent(content, note.notes ?? content.summary ?? '');

    return {
      id: note.id,
      source: 'clinical_notes',
      patient_uid: note.patient_uid,
      patient_id: note.patient_uid,
      doctor_id: doctorId != null ? String(doctorId) : null,
      doctor_name: doctor?.name ?? null,
      doctor_phone: doctor?.phone ?? null,
      doctor_email: doctor?.email ?? null,
      doctor_specialization: profile?.specialty ?? null,
      specialization: profile?.specialty ?? null,
      department: profile?.department ?? null,
      record_type: 'CONSULTATION',
      note_type: note.note_type,
      title: note.title ?? 'OP consultation',
      diagnosis,
      description: notesText,
      notes: notesText,
      treatment: firstText(content.plan),
      privacy_level: 'RESTRICTED',
      consultation_date: appointment?.appointment_date ?? note.signed_at ?? note.created_at,
      date: appointment?.appointment_date ?? note.created_at,
      created_at: note.created_at,
      updated_at: note.updated_at,
      appointment_id: note.appointment_id,
      appointment_reason: appointment?.reason ?? null,
      is_signed: note.is_signed,
    };
  });
}

export async function getConsultationsByUid(uid, filters = {}) {
  try {
    const {
      limit = DEFAULT_PAGINATION.DEFAULT_LIMIT,
      offset = DEFAULT_PAGINATION.DEFAULT_OFFSET,
    } = filters;
    const parsedLimit = parseInt(limit);
    const parsedOffset = parseInt(offset);
    const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
      ? parsedLimit
      : DEFAULT_PAGINATION.DEFAULT_LIMIT;
    const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0
      ? parsedOffset
      : DEFAULT_PAGINATION.DEFAULT_OFFSET;
    const take = safeLimit + safeOffset;

    const [medicalRecords, clinicalNotes] = await Promise.all([
      getMedicalConsultationsByUid(uid, take),
      getClinicalNoteConsultationsByUid(uid, take),
    ]);

    return [...medicalRecords, ...clinicalNotes]
      .sort((a, b) => new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime())
      .slice(safeOffset, safeOffset + safeLimit);
  } catch (error) {
    logger.error(`[RecordService] Error getting consultations by UID: ${error.message}`);
    throw error;
  }
}

export async function getMedicalRecordById(id) {
  try {
    // findFirst + is_active filter rather than findUnique, so soft-
    // deleted records aren't visible via the detail endpoint.
    const row = await prisma.medical_records.findFirst({
      where: { id: parseInt(id), is_active: true },
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
        updated_at: true,
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

export async function createMedicalRecord(data, doctorId, createdBy, tenantId = null) {
  // patient_id enters this service as an INT (the API validator enforces
  // isInt). medical_records.patient_id is a UUID (batch 87 FK now
  // enforces users.uid). Resolve int → uuid here so the rest of the
  // service stays on the right semantics.
  // RLS (Batch 3 Wave B-prime): medical_records + users are tenant-scoped
  // (relrowsecurity + tenant_id). Run the write inside setTenantTx so
  // app.current_tenant_id is set; a bare $transaction leaves it unset and
  // the tenant_isolation policy falls to its permissive branch.
  try {
    return await setTenantTx(tenantId || DEFAULT_TENANT_ID, async (tx) => {
      const patient = await tx.users.findUnique({
        where: { id: parseInt(data.patient_id) },
        select: { id: true, uid: true, name: true, phone: true },
      });

      if (!patient) throw new Error('Patient not found');

      const record = await tx.medical_records.create({
        data: {
          patient_id: patient.uid,
          doctor_id: parseInt(doctorId),
          record_type: data.record_type.toUpperCase(),
          title: data.title ?? null,
          description: data.description ?? null,
          diagnosis: data.diagnosis ?? null,
          treatment: data.treatment ?? null,
          medications: data.medications ?? null,
          lab_results: data.lab_results ?? null,
          attachments: data.attachments ?? null,
          privacy_level: data.privacy_level || 'RESTRICTED',
          created_by: createdBy ?? null,
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
          privacy_level: true,
          created_by: true,
          created_at: true,
        },
      });

      // Phase E3 follow-up — write encrypted shadow columns for the
      // PHI fields. Best-effort; raw UPDATE because Prisma client
      // doesn't model the shadow columns yet.
      await writeRecordPhiShadows(tx, record.id, {
        description: data.description, diagnosis: data.diagnosis, treatment: data.treatment,
      });

      return { record, patient };
    });
  } catch (error) {
    logger.error(`[RecordService] Error creating medical record: ${error.message}`);
    throw error;
  }
}

export async function updateMedicalRecord(id, data, updatedBy) {
  try {
    const { title, description, diagnosis, treatment, medications, lab_results, attachments } = data;

    // Match the old COALESCE semantics: only write the field when the
    // caller supplied a non-null value. Conditional-spread keys achieve
    // that without a second read-round-trip.
    const patch = { updated_at: new Date(), updated_by: updatedBy ?? null };
    if (title != null) patch.title = title;
    if (description != null) patch.description = description;
    if (diagnosis != null) patch.diagnosis = diagnosis;
    if (treatment != null) patch.treatment = treatment;
    if (medications != null) patch.medications = medications;
    if (lab_results != null) patch.lab_results = lab_results;
    if (attachments != null) patch.attachments = attachments;

    const updated = await prisma.medical_records.update({
      where: { id: parseInt(id) },
      data: patch,
      select: {
        id: true,
        patient_id: true,
        doctor_id: true,
        record_type: true,
        title: true,
        description: true,
        diagnosis: true,
        treatment: true,
        privacy_level: true,
        created_by: true,
        created_at: true,
        updated_at: true,
        updated_by: true,
      },
    });
    // Phase E3 follow-up — write the *_encrypted shadows for any PHI
    // field that was in this update.
    await writeRecordPhiShadows(prisma, updated.id, { description, diagnosis, treatment });
    return updated;
  } catch (error) {
    logger.error(`[RecordService] Error updating medical record: ${error.message}`);
    throw error;
  }
}

export async function softDeleteRecord(id, deletedBy, _reason) {
  try {
    return await prisma.medical_records.update({
      where: { id: parseInt(id) },
      data: {
        is_active: false,
        deleted_at: new Date(),
        deleted_by: deletedBy ?? null,
      },
      select: { id: true, title: true },
    });
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
        is_active: true,
        OR: [
          { title: q },
          { description: q },
          { diagnosis: q },
          { treatment: q },
          // users relation match surfaces "records where the doctor's
          // name contains the term". Patient-name search is a separate
          // findMany lookup (out of scope for this query).
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
    // patientId arrives as int (the API validator is isInt). Resolve to
    // users.uid first so the medical_records.patient_id comparisons
    // don't try to compare uuid = integer.
    const patientIntId = parseInt(patientId);
    const patientUid = await resolvePatientFilterToUuid(patientIntId);

    const [patient, recordStats, recentRecords] = await Promise.all([
      prisma.users.findUnique({
        where: { id: patientIntId },
        select: {
          name: true,
          phone: true,
          email: true,
          birthday: true,
          gender: true,
          address: true,
        },
      }),
      patientUid
        ? prisma.medical_records.groupBy({
            by: ['record_type'],
            where: { patient_id: patientUid, is_active: true },
            _count: { _all: true },
            _max: { created_at: true },
          })
        : [],
      patientUid
        ? prisma.medical_records.findMany({
            where: { patient_id: patientUid, is_active: true },
            select: {
              id: true,
              record_type: true,
              title: true,
              privacy_level: true,
              created_at: true,
              [REL_DOCTOR]: {
                select: {
                  id: true,
                  name: true,
                  doctors: { select: { specialty: true }, take: 1 },
                },
              },
            },
            orderBy: { created_at: 'desc' },
            take: 5,
          })
        : [],
    ]);

    return {
      patient,
      recordStats: recordStats.map((rs) => ({
        record_type: rs.record_type,
        count: rs._count._all,
        last_record: rs._max.created_at,
      })),
      recentRecords: recentRecords.map((r) => ({
        id: r.id,
        record_type: r.record_type,
        title: r.title,
        privacy_level: r.privacy_level,
        created_at_formatted: fmtDateTime(r.created_at),
        doctor_name: r[REL_DOCTOR]?.name ?? null,
        specialization: r[REL_DOCTOR]?.doctors?.[0]?.specialty ?? null,
      })),
    };
  } catch (error) {
    logger.error(`[RecordService] Error getting patient summary: ${error.message}`);
    throw error;
  }
}
