// src/services/emr/admissionService.js
// ADT (Admission/Discharge/Transfer) service — raw pg queries (project convention)
import prisma from '../../lib/prisma.js';
import { createPrismaDb } from '../../lib/prismaCompat.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';


const VALID_STATUS_TRANSITIONS = {
  admitted: ['transferred', 'discharged', 'lama', 'expired'],
  transferred: ['admitted', 'discharged', 'lama', 'expired'],
};

const VALID_ADMISSION_TYPES = ['elective', 'emergency', 'transfer_in'];
const VALID_PRIORITIES = ['routine', 'urgent', 'emergent'];
const VALID_CODE_STATUSES = ['full_code', 'dnr', 'dni', 'comfort_care'];
const VALID_DISCHARGE_TYPES = ['home', 'transfer', 'lama', 'expired', 'aor'];

const ADMISSION_RETURNING = `id, encounter_id, patient_uid, status, ward, bed_id, bed_number,
    attending_doctor, admitted_at, discharged_at, code_status, created_at, updated_at`;

// Compute days-since-admission when actual LOS not persisted
function computeLos(admittedAt, dischargedAt) {
  if (!admittedAt) return null;
  const end = dischargedAt ? new Date(dischargedAt) : new Date();
  return Math.max(1, Math.ceil((end - new Date(admittedAt)) / (1000 * 60 * 60 * 24)));
}

async function admitPatient(data) {
  const {
    patient_uid,
    admitting_doctor,
    attending_doctor,
    department,
    ward,
    bed_id,
    chief_complaint,
    admitting_diagnosis,
    admission_type = 'elective',
    priority = 'routine',
    insurance_info,
    emergency_contact,
    allergies = [],
    code_status = 'full_code',
    expected_los_days,
    created_by,
  } = data;

  if (!patient_uid) throw AppError.badRequest('patient_uid is required');
  if (!admitting_doctor) throw AppError.badRequest('admitting_doctor is required');
  if (!chief_complaint) throw AppError.badRequest('chief_complaint is required');
  if (!created_by) throw AppError.badRequest('created_by is required');
  if (!VALID_ADMISSION_TYPES.includes(admission_type)) {
    throw AppError.badRequest(`Invalid admission_type: ${admission_type}`);
  }
  if (!VALID_PRIORITIES.includes(priority)) {
    throw AppError.badRequest(`Invalid priority: ${priority}`);
  }
  if (!VALID_CODE_STATUSES.includes(code_status)) {
    throw AppError.badRequest(`Invalid code_status: ${code_status}`);
  }

  const consentRows = await prisma.$queryRawUnsafe(
    `SELECT id FROM patient_consents
     WHERE patient_uid = $1::uuid AND consent_type = 'treatment' AND status = 'active'
     LIMIT 1`, patient_uid);
  if (!consentRows.length) {
    throw AppError.forbidden('Active treatment consent required before admission', 'CONSENT_REQUIRED');
  }

  const existingAdmission = await prisma.$queryRawUnsafe(
    `SELECT id FROM admissions WHERE patient_uid = $1::uuid AND status IN ('admitted', 'transferred') LIMIT 1`,
    patient_uid);
  if (existingAdmission.length > 0) {
    throw AppError.conflict('Patient already has an active admission');
  }

  return prisma.$transaction(async (tx) => {
    const dbTx = createPrismaDb(tx);

    // Resolve patient_uid → users.id (beds.patient_id is int FK)
    const { rows: userRows } = await dbTx.query(
      `SELECT id, name FROM users WHERE uid = $1::uuid LIMIT 1`,
      [patient_uid]
    );
    if (!userRows.length) throw AppError.notFound('Patient not found');
    const patientIntId = userRows[0].id;
    const patientName = userRows[0].name;

    const { rows } = await dbTx.query(
      `INSERT INTO admissions (
        patient_uid, admitting_doctor, attending_doctor, department, ward, bed_id,
        chief_complaint, admitting_diagnosis, admission_type, status, priority,
        insurance_info, emergency_contact, allergies, code_status,
        expected_los_days, created_by, admitted_at, created_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
        $7, $8, $9, 'admitted', $10,
        $11::jsonb, $12::jsonb, $13, $14,
        $15, $16::uuid, NOW(), NOW()
      )
      RETURNING ${ADMISSION_RETURNING}`,
      [
        patient_uid, admitting_doctor, attending_doctor || null, department || null, ward || null, bed_id || null,
        chief_complaint, admitting_diagnosis || null, admission_type, priority,
        insurance_info ? JSON.stringify(insurance_info) : null,
        emergency_contact ? JSON.stringify(emergency_contact) : null,
        allergies, code_status,
        expected_los_days || null, created_by,
      ]
    );

    const admission = rows[0];

    if (bed_id) {
      const { rows: bedRows } = await dbTx.query(
        `SELECT id, status, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        [bed_id]
      );
      if (!bedRows.length) throw AppError.notFound('Bed not found');
      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`);
      }

      await dbTx.query(
        `UPDATE beds
         SET status = 'occupied', patient_id = $1, patient_name = $2, admitted_at = NOW(),
             assigned_at = NOW(), updated_at = NOW()
         WHERE id = $3`,
        [patientIntId, patientName, bed_id]
      );

      await dbTx.query(
        `INSERT INTO bed_transfers (patient_uid, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1::uuid, $2, NULL, $3, 'Admission', $4::uuid)`,
        [patient_uid, admission.id, bed_id, created_by]
      );
    }

    await dbTx.query(
      `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, ip_address, created_at)
       VALUES ($1::uuid, 'ADMIT_PATIENT', 'admission', $2, $3::jsonb, $4, NOW())`,
      [created_by, String(admission.id), JSON.stringify({
        patient_uid, admission_type, priority, department, ward, bed_id,
      }), null]
    );

    logger.info(`Patient ${patient_uid} admitted — admission #${admission.id}, encounter ${admission.encounter_id}`);
    return admission;
  });
}

async function dischargePatient(admissionId, dischargeData, dischargedBy) {
  const { discharge_type, discharge_summary } = dischargeData || {};

  if (!discharge_type) throw AppError.badRequest('discharge_type is required');
  if (!VALID_DISCHARGE_TYPES.includes(discharge_type)) {
    throw AppError.badRequest(`Invalid discharge_type: ${discharge_type}`);
  }
  if (!dischargedBy) throw AppError.badRequest('dischargedBy is required');

  return prisma.$transaction(async (tx) => {
    const dbTx = createPrismaDb(tx);

    const { rows: admRows } = await dbTx.query(
      `SELECT id, patient_uid, bed_id, status, admitted_at FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    const allowedFrom = VALID_STATUS_TRANSITIONS[admission.status];
    if (!allowedFrom || !allowedFrom.includes('discharged')) {
      throw AppError.invalidTransition(admission.status, 'discharged', allowedFrom || []);
    }

    const losDays = computeLos(admission.admitted_at, new Date());
    const targetStatus = discharge_type === 'lama' ? 'lama'
      : discharge_type === 'expired' ? 'expired'
      : 'discharged';

    const { rows: updated } = await dbTx.query(
      `UPDATE admissions
       SET status = $1, discharged_at = NOW(), discharge_type = $2,
           discharge_summary = $3, updated_at = NOW()
       WHERE id = $4
       RETURNING ${ADMISSION_RETURNING}`,
      [targetStatus, discharge_type,
        discharge_summary ? JSON.stringify(discharge_summary) : null,
        admissionId]
    );

    if (admission.bed_id) {
      const { rows: bedCheck } = await dbTx.query(
        `SELECT id, status FROM beds WHERE id = $1 FOR UPDATE`,
        [admission.bed_id]
      );
      if (bedCheck.length && bedCheck[0].status === 'occupied') {
        await dbTx.query(
          `UPDATE beds
           SET status = 'available', patient_id = NULL, patient_name = NULL,
               admitted_at = NULL, updated_at = NOW()
           WHERE id = $1`,
          [admission.bed_id]
        );

        await dbTx.query(
          `INSERT INTO bed_transfers (patient_uid, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
           VALUES ($1::uuid, $2, $3, $3, 'Discharge', $4::uuid)`,
          [admission.patient_uid, admissionId, admission.bed_id, dischargedBy]
        );
      }
    }

    await dbTx.query(
      `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, ip_address, created_at)
       VALUES ($1::uuid, 'DISCHARGE_PATIENT', 'admission', $2, $3::jsonb, $4, NOW())`,
      [dischargedBy, String(admissionId), JSON.stringify({
        discharge_type, los_days: losDays, patient_uid: admission.patient_uid,
      }), null]
    );

    logger.info(`Admission #${admissionId} discharged (${discharge_type}), LOS ${losDays} days`);
    return { ...updated[0], los_days: losDays };
  });
}

async function transferPatient(admissionId, toWardId, toBedId, reason, transferredBy) {
  if (!toBedId) throw AppError.badRequest('to_bed_id is required');
  if (!transferredBy) throw AppError.badRequest('transferredBy is required');

  return prisma.$transaction(async (tx) => {
    const dbTx = createPrismaDb(tx);

    const { rows: admRows } = await dbTx.query(
      `SELECT id, patient_uid, bed_id, ward, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    if (!['admitted', 'transferred'].includes(admission.status)) {
      throw AppError.badRequest(`Cannot transfer admission in status: ${admission.status}`);
    }

    const fromBedId = admission.bed_id;

    // Lock target bed + lookup ward name
    const { rows: targetBedRows } = await dbTx.query(
      `SELECT b.id, b.status, b.bed_number, w.name AS ward_name
       FROM beds b
       LEFT JOIN wards w ON b.ward_id = w.id
       WHERE b.id = $1 FOR UPDATE OF b`,
      [toBedId]
    );
    if (!targetBedRows.length) throw AppError.notFound('Target bed not found');
    if (targetBedRows[0].status !== 'available') {
      throw AppError.badRequest(`Target bed ${targetBedRows[0].bed_number} is not available (current status: ${targetBedRows[0].status})`);
    }

    // Resolve patient int id for beds FK
    const { rows: uRows } = await dbTx.query(
      `SELECT id, name FROM users WHERE uid = $1::uuid LIMIT 1`,
      [admission.patient_uid]
    );
    const patientIntId = uRows[0]?.id ?? null;
    const patientName = uRows[0]?.name ?? null;

    if (fromBedId) {
      await dbTx.query(
        `UPDATE beds
         SET status = 'available', patient_id = NULL, patient_name = NULL,
             admitted_at = NULL, updated_at = NOW()
         WHERE id = $1`,
        [fromBedId]
      );
    }

    await dbTx.query(
      `UPDATE beds
       SET status = 'occupied', patient_id = $1, patient_name = $2,
           admitted_at = NOW(), assigned_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [patientIntId, patientName, toBedId]
    );

    await dbTx.query(
      `INSERT INTO bed_transfers (patient_uid, admission_id, from_bed_id, to_bed_id, reason, transferred_by)
       VALUES ($1::uuid, $2, $3, $4, $5, $6::uuid)`,
      [admission.patient_uid, admissionId, fromBedId || null, toBedId, reason || 'Transfer', transferredBy]
    );

    const newWard = toWardId || targetBedRows[0].ward_name || admission.ward;

    const { rows: updated } = await dbTx.query(
      `UPDATE admissions
       SET bed_id = $1, ward = $2, bed_number = $3, status = 'transferred', updated_at = NOW()
       WHERE id = $4
       RETURNING ${ADMISSION_RETURNING}`,
      [toBedId, newWard, targetBedRows[0].bed_number, admissionId]
    );

    await dbTx.query(
      `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, ip_address, created_at)
       VALUES ($1::uuid, 'TRANSFER_PATIENT', 'admission', $2, $3::jsonb, $4, NOW())`,
      [transferredBy, String(admissionId), JSON.stringify({
        from_bed_id: fromBedId, to_bed_id: toBedId, to_ward: newWard, reason,
        patient_uid: admission.patient_uid,
      }), null]
    );

    logger.info(`Admission #${admissionId} transferred: bed ${fromBedId} -> ${toBedId}`);
    return updated[0];
  });
}

async function getActiveAdmissions(filters = {}) {
  const { ward, doctor, department, status, page = 1, limit = 20 } = filters;
  const conditions = [];
  const params = [];
  let idx = 1;

  if (status) {
    conditions.push(`a.status = $${idx}`);
    params.push(status);
    idx++;
  } else {
    conditions.push(`a.status IN ('admitted', 'transferred')`);
  }

  if (ward) {
    conditions.push(`a.ward = $${idx}`);
    params.push(ward);
    idx++;
  }
  if (doctor) {
    conditions.push(`(a.admitting_doctor = $${idx}::uuid OR a.attending_doctor = $${idx}::uuid)`);
    params.push(doctor);
    idx++;
  }
  if (department) {
    conditions.push(`a.department = $${idx}`);
    params.push(department);
    idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10)));
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * safeLimit;

  const countRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS total FROM admissions a ${where}`,
    ...params
  );

  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.encounter_id, a.patient_uid, a.admitting_doctor, a.attending_doctor,
            a.department, a.ward, a.bed_id, a.bed_number, a.chief_complaint, a.admitting_diagnosis,
            a.admission_type, a.status, a.priority, a.code_status, a.allergies,
            a.admitted_at, a.expected_los_days,
            u.name AS patient_name, u.phone AS patient_phone,
            w.name AS bed_ward_name
     FROM admissions a
     LEFT JOIN users u ON a.patient_uid = u.uid
     LEFT JOIN beds b ON a.bed_id = b.id
     LEFT JOIN wards w ON b.ward_id = w.id
     ${where}
     ORDER BY a.admitted_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    ...params, safeLimit, offset);

  const total = countRows[0]?.total || 0;
  return {
    admissions: rows,
    pagination: {
      page: parseInt(page, 10),
      limit: safeLimit,
      total,
      totalPages: Math.ceil(total / safeLimit),
    },
  };
}

async function getAdmissionDetail(admissionId, requestContext = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.*,
            u.name AS patient_name, u.phone AS patient_phone, u.gender AS patient_gender,
            u.email AS patient_email, u.birthday AS patient_birthday,
            w.name AS bed_ward_name,
            ad.name AS admitting_doctor_name,
            atd.name AS attending_doctor_name
     FROM admissions a
     LEFT JOIN users u ON a.patient_uid = u.uid
     LEFT JOIN beds b ON a.bed_id = b.id
     LEFT JOIN wards w ON b.ward_id = w.id
     LEFT JOIN staff ad ON a.admitting_doctor = ad.uid
     LEFT JOIN staff atd ON a.attending_doctor = atd.uid
     WHERE a.id = $1`, admissionId);

  if (!rows.length) throw AppError.notFound('Admission not found');

  const row = rows[0];
  row.los_days = computeLos(row.admitted_at, row.discharged_at);

  if (requestContext.userId) {
    logPhiAccess({
      userId: requestContext.userId,
      userRole: requestContext.userRole,
      patientId: row.patient_uid,
      recordType: 'admission_detail',
      action: 'VIEW',
      ip: requestContext.ip,
      requestId: requestContext.requestId,
    });
  }

  return row;
}

async function getPatientAdmissionHistory(patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT a.id, a.encounter_id, a.admitting_doctor, a.attending_doctor,
            a.department, a.ward, a.bed_id, a.bed_number, a.chief_complaint, a.admitting_diagnosis,
            a.admission_type, a.status, a.priority, a.code_status,
            a.admitted_at, a.discharged_at, a.discharge_type, a.expected_los_days
     FROM admissions a
     WHERE a.patient_uid = $1::uuid
     ORDER BY a.admitted_at DESC`, patientUid);

  return rows.map((r) => ({ ...r, los_days: computeLos(r.admitted_at, r.discharged_at) }));
}

async function updateCodeStatus(admissionId, codeStatus, updatedBy) {
  if (!VALID_CODE_STATUSES.includes(codeStatus)) {
    throw AppError.badRequest(`Invalid code_status: ${codeStatus}`);
  }
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  return prisma.$transaction(async (tx) => {
    const dbTx = createPrismaDb(tx);

    const { rows: admRows } = await dbTx.query(
      `SELECT id, code_status, patient_uid, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update code status for a non-active admission');
    }

    const previousStatus = admRows[0].code_status;

    const { rows: updated } = await dbTx.query(
      `UPDATE admissions SET code_status = $1, updated_at = NOW() WHERE id = $2
       RETURNING ${ADMISSION_RETURNING}`,
      [codeStatus, admissionId]
    );

    await dbTx.query(
      `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, ip_address, created_at)
       VALUES ($1::uuid, 'UPDATE_CODE_STATUS', 'admission', $2, $3::jsonb, $4, NOW())`,
      [updatedBy, String(admissionId), JSON.stringify({
        previous: previousStatus, new: codeStatus, patient_uid: admRows[0].patient_uid,
      }), null]
    );

    logger.info(`Admission #${admissionId} code status changed: ${previousStatus} -> ${codeStatus}`);
    return updated[0];
  });
}

async function updateAttendingDoctor(admissionId, doctorUid, updatedBy) {
  if (!doctorUid) throw AppError.badRequest('doctor_uid is required');
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  return prisma.$transaction(async (tx) => {
    const dbTx = createPrismaDb(tx);

    const { rows: admRows } = await dbTx.query(
      `SELECT id, attending_doctor, patient_uid, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update attending doctor for a non-active admission');
    }

    const previousDoctor = admRows[0].attending_doctor;

    const { rows: updated } = await dbTx.query(
      `UPDATE admissions SET attending_doctor = $1::uuid, updated_at = NOW() WHERE id = $2
       RETURNING ${ADMISSION_RETURNING}`,
      [doctorUid, admissionId]
    );

    await dbTx.query(
      `INSERT INTO audit_logs (uid, action, resource, resource_id, metadata, ip_address, created_at)
       VALUES ($1::uuid, 'UPDATE_ATTENDING_DOCTOR', 'admission', $2, $3::jsonb, $4, NOW())`,
      [updatedBy, String(admissionId), JSON.stringify({
        previous_doctor: previousDoctor, new_doctor: doctorUid, patient_uid: admRows[0].patient_uid,
      }), null]
    );

    logger.info(`Admission #${admissionId} attending doctor changed: ${previousDoctor} -> ${doctorUid}`);
    return updated[0];
  });
}

async function getAdmissionStats(dateFrom, dateTo) {
  const params = [];
  let dateFilter = '';
  let idx = 1;

  if (dateFrom) {
    dateFilter += ` AND a.admitted_at >= $${idx}`;
    params.push(dateFrom);
    idx++;
  }
  if (dateTo) {
    dateFilter += ` AND a.admitted_at <= $${idx}`;
    params.push(dateTo);
    idx++;
  }

  // LOS computed inline from admitted_at/discharged_at since actual_los_days isn't persisted
  const statsRows = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS total_admissions,
       COUNT(*) FILTER (WHERE a.status IN ('discharged','lama','expired'))::int AS total_discharged,
       ROUND(AVG(
         CASE WHEN a.discharged_at IS NOT NULL
              THEN GREATEST(1, CEIL(EXTRACT(EPOCH FROM (a.discharged_at - a.admitted_at)) / 86400.0))
         END
       ), 1) AS avg_los_days,
       COUNT(*) FILTER (WHERE a.status = 'admitted')::int AS currently_admitted,
       COUNT(*) FILTER (WHERE a.status = 'transferred')::int AS currently_transferred
     FROM admissions a
     WHERE 1=1 ${dateFilter}`,
    ...params
  );

  const dischargeBreakdown = await prisma.$queryRawUnsafe(
    `SELECT a.discharge_type, COUNT(*)::int AS count
     FROM admissions a
     WHERE a.discharge_type IS NOT NULL ${dateFilter}
     GROUP BY a.discharge_type
     ORDER BY count DESC`,
    ...params
  );

  const admissionTypeBreakdown = await prisma.$queryRawUnsafe(
    `SELECT a.admission_type, COUNT(*)::int AS count
     FROM admissions a
     WHERE 1=1 ${dateFilter}
     GROUP BY a.admission_type
     ORDER BY count DESC`,
    ...params
  );

  const bedStats = await prisma.$queryRawUnsafe(
    `SELECT
       COUNT(*)::int AS total_beds,
       COUNT(*) FILTER (WHERE status = 'occupied')::int AS occupied_beds
     FROM beds`
  );

  const bed = bedStats[0] || { total_beds: 0, occupied_beds: 0 };
  const occupancyRate = bed.total_beds > 0
    ? Math.round((bed.occupied_beds / bed.total_beds) * 100 * 100) / 100
    : 0;

  return {
    ...(statsRows[0] || {}),
    occupancy_rate: occupancyRate,
    total_beds: bed.total_beds,
    occupied_beds: bed.occupied_beds,
    discharge_type_breakdown: dischargeBreakdown,
    admission_type_breakdown: admissionTypeBreakdown,
  };
}

export default {
  admitPatient,
  dischargePatient,
  transferPatient,
  getActiveAdmissions,
  getAdmissionDetail,
  getPatientAdmissionHistory,
  updateCodeStatus,
  updateAttendingDoctor,
  getAdmissionStats,
};
