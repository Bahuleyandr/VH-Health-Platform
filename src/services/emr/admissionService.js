// src/services/emr/admissionService.js
// ADT (Admission/Discharge/Transfer) service — raw pg queries (project convention)
import db from '../../config/database.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import bedManagementService from '../bed/bedManagementService.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';

// ===================================================================
// Valid status transitions for state-machine enforcement
// ===================================================================
const VALID_STATUS_TRANSITIONS = {
  admitted: ['transferred', 'discharged', 'lama', 'expired'],
  transferred: ['admitted', 'discharged', 'lama', 'expired'],
};

const VALID_ADMISSION_TYPES = ['elective', 'emergency', 'transfer_in'];
const VALID_PRIORITIES = ['routine', 'urgent', 'emergent'];
const VALID_CODE_STATUSES = ['full_code', 'dnr', 'dni', 'comfort_care'];
const VALID_DISCHARGE_TYPES = ['home', 'transfer', 'lama', 'expired', 'aor'];

// ===================================================================
// admitPatient — Create admission + assign bed + audit
// ===================================================================
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

  // Input validation
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

  // Consent check (HIPAA)
  const { rows: consentRows } = await db.query(
    `SELECT id FROM patient_consents
     WHERE patient_uid = $1 AND consent_type = 'treatment' AND status = 'active'
     LIMIT 1`,
    [patient_uid]
  );
  if (!consentRows.length) {
    throw AppError.forbidden('Active treatment consent required before admission', 'CONSENT_REQUIRED');
  }

  // Check patient is not already actively admitted
  const { rows: existingAdmission } = await db.query(
    `SELECT id FROM admissions WHERE patient_uid = $1 AND status IN ('admitted', 'transferred') LIMIT 1`,
    [patient_uid]
  );
  if (existingAdmission.length > 0) {
    throw AppError.conflict('Patient already has an active admission');
  }

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Create admission record
    const { rows } = await client.query(
      `INSERT INTO admissions (
        patient_uid, admitting_doctor, attending_doctor, department, ward, bed_id,
        chief_complaint, admitting_diagnosis, admission_type, status, priority,
        insurance_info, emergency_contact, allergies, code_status,
        expected_los_days, created_by, admitted_at, created_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, 'admitted', $10,
        $11, $12, $13, $14,
        $15, $16, NOW(), NOW()
      )
      RETURNING *`,
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

    // Assign bed if bed_id provided
    if (bed_id) {
      // Lock and assign bed within same transaction
      const { rows: bedRows } = await client.query(
        `SELECT id, status, bed_number FROM beds WHERE id = $1 FOR UPDATE`,
        [bed_id]
      );
      if (!bedRows.length) {
        throw AppError.notFound('Bed not found');
      }
      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`);
      }

      await client.query(
        `UPDATE beds
         SET status = 'occupied', patient_uid = $1, admitted_at = NOW(), updated_at = NOW()
         WHERE id = $2`,
        [patient_uid, bed_id]
      );

      // Record in bed_transfers
      await client.query(
        `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
         VALUES ($1, NULL, $2, 'Admission', $3)`,
        [patient_uid, bed_id, created_by]
      );
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES ($1, 'ADMIT_PATIENT', 'admission', $2, $3, $4, NOW())`,
      [created_by, String(admission.id), JSON.stringify({
        patient_uid, admission_type, priority, department, ward, bed_id,
      }), null]
    );

    await client.query('COMMIT');
    logger.info(`Patient ${patient_uid} admitted — admission #${admission.id}, encounter ${admission.encounter_id}`);
    return admission;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===================================================================
// dischargePatient — Update status, release bed, calculate LOS
// ===================================================================
async function dischargePatient(admissionId, dischargeData, dischargedBy) {
  const {
    discharge_type,
    discharge_summary,
  } = dischargeData || {};

  if (!discharge_type) throw AppError.badRequest('discharge_type is required');
  if (!VALID_DISCHARGE_TYPES.includes(discharge_type)) {
    throw AppError.badRequest(`Invalid discharge_type: ${discharge_type}`);
  }
  if (!dischargedBy) throw AppError.badRequest('dischargedBy is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock admission
    const { rows: admRows } = await client.query(
      `SELECT id, patient_uid, bed_id, status, admitted_at FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    const allowedFrom = VALID_STATUS_TRANSITIONS[admission.status];
    if (!allowedFrom || !allowedFrom.includes('discharged')) {
      throw AppError.invalidTransition(admission.status, 'discharged', allowedFrom || []);
    }

    // Calculate actual LOS
    const admittedAt = new Date(admission.admitted_at);
    const now = new Date();
    const actualLosDays = Math.max(1, Math.ceil((now - admittedAt) / (1000 * 60 * 60 * 24)));

    // Update admission
    const targetStatus = discharge_type === 'lama' ? 'lama' : discharge_type === 'expired' ? 'expired' : 'discharged';

    const { rows: updated } = await client.query(
      `UPDATE admissions
       SET status = $1, discharged_at = NOW(), discharge_type = $2,
           discharge_summary = $3, actual_los_days = $4, updated_at = NOW()
       WHERE id = $5
       RETURNING *`,
      [targetStatus, discharge_type, discharge_summary ? JSON.stringify(discharge_summary) : null, actualLosDays, admissionId]
    );

    // Release bed if assigned
    if (admission.bed_id) {
      // Discharge bed — set to cleaning
      const { rows: bedCheck } = await client.query(
        `SELECT id, status FROM beds WHERE id = $1 FOR UPDATE`,
        [admission.bed_id]
      );
      if (bedCheck.length && bedCheck[0].status === 'occupied') {
        await client.query(
          `UPDATE beds
           SET status = 'cleaning', patient_uid = NULL, admitted_at = NULL,
               expected_discharge = NULL, updated_at = NOW()
           WHERE id = $1`,
          [admission.bed_id]
        );

        await client.query(
          `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
           VALUES ($1, $2, $2, 'Discharge', $3)`,
          [admission.patient_uid, admission.bed_id, dischargedBy]
        );
      }
    }

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES ($1, 'DISCHARGE_PATIENT', 'admission', $2, $3, $4, NOW())`,
      [dischargedBy, String(admissionId), JSON.stringify({
        discharge_type, actual_los_days: actualLosDays, patient_uid: admission.patient_uid,
      }), null]
    );

    await client.query('COMMIT');
    logger.info(`Admission #${admissionId} discharged (${discharge_type}), LOS ${actualLosDays} days`);
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===================================================================
// transferPatient — Move to new ward/bed
// ===================================================================
async function transferPatient(admissionId, toWardId, toBedId, reason, transferredBy) {
  if (!toBedId) throw AppError.badRequest('to_bed_id is required');
  if (!transferredBy) throw AppError.badRequest('transferredBy is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock admission
    const { rows: admRows } = await client.query(
      `SELECT id, patient_uid, bed_id, ward, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    if (!['admitted', 'transferred'].includes(admission.status)) {
      throw AppError.badRequest(`Cannot transfer admission in status: ${admission.status}`);
    }

    const fromBedId = admission.bed_id;

    // Lock target bed
    const { rows: targetBedRows } = await client.query(
      `SELECT id, status, bed_number, ward_name FROM beds WHERE id = $1 FOR UPDATE`,
      [toBedId]
    );
    if (!targetBedRows.length) throw AppError.notFound('Target bed not found');
    if (targetBedRows[0].status !== 'available') {
      throw AppError.badRequest(`Target bed ${targetBedRows[0].bed_number} is not available (current status: ${targetBedRows[0].status})`);
    }

    // Release old bed if assigned
    if (fromBedId) {
      await client.query(
        `UPDATE beds
         SET status = 'cleaning', patient_uid = NULL, admitted_at = NULL,
             expected_discharge = NULL, updated_at = NOW()
         WHERE id = $1`,
        [fromBedId]
      );
    }

    // Assign new bed
    await client.query(
      `UPDATE beds
       SET status = 'occupied', patient_uid = $1, admitted_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [admission.patient_uid, toBedId]
    );

    // Record in bed_transfers
    await client.query(
      `INSERT INTO bed_transfers (patient_uid, from_bed_id, to_bed_id, reason, transferred_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [admission.patient_uid, fromBedId || null, toBedId, reason || 'Transfer', transferredBy]
    );

    // Determine new ward name
    const newWard = toWardId || targetBedRows[0].ward_name || admission.ward;

    // Update admission
    const { rows: updated } = await client.query(
      `UPDATE admissions
       SET bed_id = $1, ward = $2, status = 'transferred', updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [toBedId, newWard, admissionId]
    );

    // Audit log
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES ($1, 'TRANSFER_PATIENT', 'admission', $2, $3, $4, NOW())`,
      [transferredBy, String(admissionId), JSON.stringify({
        from_bed_id: fromBedId, to_bed_id: toBedId, to_ward: newWard, reason,
        patient_uid: admission.patient_uid,
      }), null]
    );

    await client.query('COMMIT');
    logger.info(`Admission #${admissionId} transferred: bed ${fromBedId} -> ${toBedId}`);
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===================================================================
// getActiveAdmissions — List with pagination and filters
// ===================================================================
async function getActiveAdmissions(filters = {}) {
  const { ward, doctor, department, status, page = 1, limit = 20 } = filters;
  const conditions = [];
  const params = [];
  let idx = 1;

  // Default to active statuses
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
    conditions.push(`(a.admitting_doctor = $${idx} OR a.attending_doctor = $${idx})`);
    params.push(doctor);
    idx++;
  }
  if (department) {
    conditions.push(`a.department = $${idx}`);
    params.push(department);
    idx++;
  }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
  const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10)));

  // Count
  const { rows: countRows } = await db.readQuery(
    `SELECT COUNT(*)::int AS total FROM admissions a ${where}`,
    params
  );

  // Fetch
  const { rows } = await db.readQuery(
    `SELECT a.id, a.encounter_id, a.patient_uid, a.admitting_doctor, a.attending_doctor,
            a.department, a.ward, a.bed_id, a.chief_complaint, a.admitting_diagnosis,
            a.admission_type, a.status, a.priority, a.code_status, a.allergies,
            a.admitted_at, a.expected_los_days,
            u.name AS patient_name, u.phone AS patient_phone,
            b.bed_number, b.ward_name AS bed_ward_name
     FROM admissions a
     LEFT JOIN users u ON a.patient_uid = u.uid
     LEFT JOIN beds b ON a.bed_id = b.id
     ${where}
     ORDER BY a.admitted_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, safeLimit, offset]
  );

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

// ===================================================================
// getAdmissionDetail — Full detail with patient, bed, doctor info
// ===================================================================
async function getAdmissionDetail(admissionId, requestContext = {}) {
  const { rows } = await db.readQuery(
    `SELECT a.*,
            u.name AS patient_name, u.phone AS patient_phone, u.gender AS patient_gender,
            u.email AS patient_email, u.birthday AS patient_birthday,
            b.bed_number, b.ward_name AS bed_ward_name, b.floor AS bed_floor, b.bed_type,
            ad.name AS admitting_doctor_name,
            atd.name AS attending_doctor_name
     FROM admissions a
     LEFT JOIN users u ON a.patient_uid = u.uid
     LEFT JOIN beds b ON a.bed_id = b.id
     LEFT JOIN staff ad ON a.admitting_doctor = ad.uid
     LEFT JOIN staff atd ON a.attending_doctor = atd.uid
     WHERE a.id = $1`,
    [admissionId]
  );

  if (!rows.length) throw AppError.notFound('Admission not found');

  // HIPAA: log PHI access
  if (requestContext.userId) {
    logPhiAccess({
      userId: requestContext.userId,
      userRole: requestContext.userRole,
      patientId: rows[0].patient_uid,
      recordType: 'admission_detail',
      action: 'VIEW',
      ip: requestContext.ip,
      requestId: requestContext.requestId,
    });
  }

  return rows[0];
}

// ===================================================================
// getPatientAdmissionHistory — All admissions for a patient
// ===================================================================
async function getPatientAdmissionHistory(patientUid) {
  if (!patientUid) throw AppError.badRequest('patient_uid is required');

  const { rows } = await db.readQuery(
    `SELECT a.id, a.encounter_id, a.admitting_doctor, a.attending_doctor,
            a.department, a.ward, a.bed_id, a.chief_complaint, a.admitting_diagnosis,
            a.admission_type, a.status, a.priority, a.code_status,
            a.admitted_at, a.discharged_at, a.discharge_type,
            a.actual_los_days, a.expected_los_days,
            b.bed_number
     FROM admissions a
     LEFT JOIN beds b ON a.bed_id = b.id
     WHERE a.patient_uid = $1
     ORDER BY a.admitted_at DESC`,
    [patientUid]
  );

  return rows;
}

// ===================================================================
// updateCodeStatus — Update DNR/code status with audit
// ===================================================================
async function updateCodeStatus(admissionId, codeStatus, updatedBy) {
  if (!VALID_CODE_STATUSES.includes(codeStatus)) {
    throw AppError.badRequest(`Invalid code_status: ${codeStatus}`);
  }
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: admRows } = await client.query(
      `SELECT id, code_status, patient_uid, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update code status for a non-active admission');
    }

    const previousStatus = admRows[0].code_status;

    const { rows: updated } = await client.query(
      `UPDATE admissions SET code_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [codeStatus, admissionId]
    );

    // Audit — code status changes are clinically critical
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES ($1, 'UPDATE_CODE_STATUS', 'admission', $2, $3, $4, NOW())`,
      [updatedBy, String(admissionId), JSON.stringify({
        previous: previousStatus, new: codeStatus, patient_uid: admRows[0].patient_uid,
      }), null]
    );

    await client.query('COMMIT');
    logger.info(`Admission #${admissionId} code status changed: ${previousStatus} -> ${codeStatus}`);
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===================================================================
// updateAttendingDoctor — Change attending physician with audit
// ===================================================================
async function updateAttendingDoctor(admissionId, doctorUid, updatedBy) {
  if (!doctorUid) throw AppError.badRequest('doctor_uid is required');
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: admRows } = await client.query(
      `SELECT id, attending_doctor, patient_uid, status FROM admissions WHERE id = $1 FOR UPDATE`,
      [admissionId]
    );
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update attending doctor for a non-active admission');
    }

    const previousDoctor = admRows[0].attending_doctor;

    const { rows: updated } = await client.query(
      `UPDATE admissions SET attending_doctor = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [doctorUid, admissionId]
    );

    // Audit
    await client.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address, created_at)
       VALUES ($1, 'UPDATE_ATTENDING_DOCTOR', 'admission', $2, $3, $4, NOW())`,
      [updatedBy, String(admissionId), JSON.stringify({
        previous_doctor: previousDoctor, new_doctor: doctorUid, patient_uid: admRows[0].patient_uid,
      }), null]
    );

    await client.query('COMMIT');
    logger.info(`Admission #${admissionId} attending doctor changed: ${previousDoctor} -> ${doctorUid}`);
    return updated[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ===================================================================
// getAdmissionStats — Aggregate statistics for a date range
// ===================================================================
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

  // Total admissions, avg LOS, discharge type breakdown
  const { rows: statsRows } = await db.readQuery(
    `SELECT
       COUNT(*)::int AS total_admissions,
       COUNT(*) FILTER (WHERE a.status IN ('discharged','lama','expired'))::int AS total_discharged,
       ROUND(AVG(a.actual_los_days) FILTER (WHERE a.actual_los_days IS NOT NULL), 1) AS avg_los_days,
       COUNT(*) FILTER (WHERE a.status = 'admitted')::int AS currently_admitted,
       COUNT(*) FILTER (WHERE a.status = 'transferred')::int AS currently_transferred
     FROM admissions a
     WHERE 1=1 ${dateFilter}`,
    params
  );

  // Discharge type breakdown
  const { rows: dischargeBreakdown } = await db.readQuery(
    `SELECT a.discharge_type, COUNT(*)::int AS count
     FROM admissions a
     WHERE a.discharge_type IS NOT NULL ${dateFilter}
     GROUP BY a.discharge_type
     ORDER BY count DESC`,
    params
  );

  // Admission type breakdown
  const { rows: admissionTypeBreakdown } = await db.readQuery(
    `SELECT a.admission_type, COUNT(*)::int AS count
     FROM admissions a
     WHERE 1=1 ${dateFilter}
     GROUP BY a.admission_type
     ORDER BY count DESC`,
    params
  );

  // Occupancy rate
  const { rows: bedStats } = await db.readQuery(
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
