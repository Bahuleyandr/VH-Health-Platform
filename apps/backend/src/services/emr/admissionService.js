// src/services/emr/admissionService.js
// ADT (Admission/Discharge/Transfer) service — typed Prisma ORM.
// Batch 55: migrated from raw `dbTx.query` / `prisma.$queryRawUnsafe`
// to typed Prisma. The only remaining raw-SQL sites are the
// `SELECT ... FOR UPDATE` row locks inside transactions, which Prisma's
// typed surface still can't express; everything else (audit_logs,
// admissions/beds/bed_transfers/patient_consents CRUD, stats) is now
// going through the typed client.
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { logPhiAccess } from '../../utils/hipaaAudit.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';


const VALID_STATUS_TRANSITIONS = {
  admitted: ['transferred', 'discharged', 'lama', 'expired'],
  transferred: ['admitted', 'discharged', 'lama', 'expired'],
};

// `day_care` covers same-day surgical (cataract, dialysis-access creation,
// minor laparoscopic, etc.) — admit in morning, discharge same evening.
// Previously had to be miscoded as `elective`, breaking package billing
// and the day-care discharge template. See finding
// 2026-05-08-surgical-day-care-admission-no-day-care-type.
const VALID_ADMISSION_TYPES = ['elective', 'emergency', 'transfer_in', 'day_care'];
const VALID_PRIORITIES = ['routine', 'urgent', 'emergent'];
const VALID_CODE_STATUSES = ['full_code', 'dnr', 'dni', 'comfort_care'];
const VALID_DISCHARGE_TYPES = ['home', 'transfer', 'lama', 'expired', 'aor'];

// Columns returned by the pre-batch-55 `RETURNING` clause. Mirrored as
// a Prisma `select` so the public response shape is unchanged.
const ADMISSION_RETURNING_SELECT = {
  id: true,
  encounter_id: true,
  patient_uid: true,
  status: true,
  ward: true,
  bed_id: true,
  bed_number: true,
  attending_doctor: true,
  admitted_at: true,
  discharged_at: true,
  code_status: true,
  created_at: true,
  updated_at: true,
};

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

  const consent = await prisma.patient_consents.findFirst({
    where: { patient_uid, consent_type: 'treatment', status: 'active' },
    select: { id: true },
  });
  if (!consent) {
    throw AppError.forbidden('Active treatment consent required before admission', 'CONSENT_REQUIRED');
  }

  const existingAdmission = await prisma.admissions.findFirst({
    where: { patient_uid, status: { in: ['admitted', 'transferred'] } },
    select: { id: true },
  });
  if (existingAdmission) {
    throw AppError.conflict('Patient already has an active admission');
  }

  return prisma.$transaction(async (tx) => {
    // Resolve patient_uid → users.id (beds.patient_id is int FK)
    const patientUser = await tx.users.findUnique({
      where: { uid: patient_uid },
      select: { id: true, name: true },
    });
    if (!patientUser) throw AppError.notFound('Patient not found');
    const patientIntId = patientUser.id;
    const patientName = patientUser.name;

    const admission = await tx.admissions.create({
      data: {
        patient_uid,
        admitting_doctor,
        attending_doctor: attending_doctor ?? null,
        department: department ?? null,
        ward: ward ?? null,
        bed_id: bed_id ?? null,
        chief_complaint,
        admitting_diagnosis: admitting_diagnosis ?? null,
        admission_type,
        status: 'admitted',
        priority,
        insurance_info: insurance_info ?? null,
        emergency_contact: emergency_contact ?? null,
        allergies,
        code_status,
        expected_los_days: expected_los_days ?? null,
        created_by,
        admitted_at: new Date(),
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    if (bed_id) {
      // FOR UPDATE lock on the bed row to serialise concurrent admits.
      // Prisma typed methods can't issue row locks, so we keep the SELECT
      // raw inside the transaction; the subsequent UPDATE is typed.
      const bedRows = await tx.$queryRaw`
        SELECT id, status, bed_number FROM beds WHERE id = ${bed_id} FOR UPDATE
      `;
      if (!bedRows.length) throw AppError.notFound('Bed not found');
      if (bedRows[0].status !== 'available') {
        throw AppError.badRequest(`Bed ${bedRows[0].bed_number} is not available (current status: ${bedRows[0].status})`);
      }

      await tx.beds.update({
        where: { id: bed_id },
        data: {
          status: 'occupied',
          patient_id: patientIntId,
          patient_name: patientName,
          admitted_at: new Date(),
          assigned_at: new Date(),
          updated_at: new Date(),
        },
      });

      await tx.bed_transfers.create({
        data: {
          patient_uid,
          admission_id: admission.id,
          from_bed_id: null,
          to_bed_id: bed_id,
          reason: 'Admission',
          transferred_by: created_by,
        },
      });
    }

    await tx.audit_logs.create({
      data: {
        uid: created_by,
        action: 'ADMIT_PATIENT',
        resource: 'admission',
        resource_id: String(admission.id),
        metadata: {
          patient_uid, admission_type, priority, department, ward, bed_id,
        },
        ip_address: null,
      },
    });

    logger.info(`Patient ${patient_uid} admitted — admission #${admission.id}, encounter ${admission.encounter_id}`);
    return admission;
  });
}

async function dischargePatient(admissionId, dischargeData, dischargedBy) {
  const { discharge_type, discharge_summary, override_readiness_gate } = dischargeData || {};

  if (!discharge_type) throw AppError.badRequest('discharge_type is required');
  if (!VALID_DISCHARGE_TYPES.includes(discharge_type)) {
    throw AppError.badRequest(`Invalid discharge_type: ${discharge_type}`);
  }
  if (!dischargedBy) throw AppError.badRequest('dischargedBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on the admission to serialise concurrent state changes.
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, bed_id, status, admitted_at
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    const allowedFrom = VALID_STATUS_TRANSITIONS[admission.status];
    if (!allowedFrom || !allowedFrom.includes('discharged')) {
      throw AppError.invalidTransition(admission.status, 'discharged', allowedFrom || []);
    }

    // Discharge readiness gate. `lama` (left against medical advice) and
    // `expired` (deceased) bypass the gate by definition; planned home
    // discharges must clear (a) discharge_summary present, (b) no
    // unpaid invoice for this admission, (c) no still-pending lab/imaging
    // results. Explicit `override_readiness_gate: true` lets the
    // discharge counter override (with audit). See finding
    // 2026-05-08-tpa-insurance-claim-discharge-no-readiness-gate.
    const READINESS_GATED_TYPES = new Set(['home', 'transfer', 'aor']);
    if (READINESS_GATED_TYPES.has(discharge_type) && override_readiness_gate !== true) {
      const blockers = [];
      if (!discharge_summary || !String(discharge_summary).trim()) {
        blockers.push({ type: 'SUMMARY_MISSING', message: 'discharge_summary must be present and signed before discharge.' });
      }
      try {
        const unpaid = await tx.$queryRawUnsafe(
          `SELECT id, invoice_number, COALESCE(total_amount, 0) - COALESCE(paid_amount, 0) AS balance
             FROM invoices
            WHERE admission_id = $1
              AND COALESCE(status, '') NOT IN ('paid', 'written_off', 'cancelled')
              AND COALESCE(total_amount, 0) > COALESCE(paid_amount, 0)
            LIMIT 5`,
          admissionId,
        );
        if (unpaid.length > 0) {
          blockers.push({
            type: 'UNPAID_INVOICE',
            message: `Outstanding invoice(s) on this admission: ${unpaid.map((i) => `${i.invoice_number} (₹${i.balance})`).join(', ')}.`,
            invoices: unpaid,
          });
        }
      } catch (e) {
        // The invoices table may carry slightly different column names in
        // some deploys (paid_amount vs payments rollup). Don't fail the
        // gate on a query error — log and continue with the rest. The
        // override path remains for cases where this query simply can't
        // run.
        logger.warn(`Discharge readiness: invoice check skipped (${e.message})`);
      }
      try {
        const pendingResults = await tx.$queryRawUnsafe(
          `SELECT id FROM investigations
            WHERE patient_id = (SELECT patient_id FROM admissions WHERE id = $1)
              AND COALESCE(status, '') NOT IN ('COMPLETED', 'CANCELLED', 'completed', 'cancelled')
              AND created_at >= (SELECT admitted_at FROM admissions WHERE id = $1)
            LIMIT 5`,
          admissionId,
        );
        if (pendingResults.length > 0) {
          blockers.push({
            type: 'PENDING_RESULTS',
            message: `${pendingResults.length} pending lab/imaging result(s) tied to this admission. Review or cancel before discharge.`,
            count: pendingResults.length,
          });
        }
      } catch (e) {
        logger.warn(`Discharge readiness: pending-results check skipped (${e.message})`);
      }

      if (blockers.length > 0) {
        const err = AppError.badRequest('Discharge blocked — readiness gate not met. Pass `override_readiness_gate: true` with a reason in discharge_summary to override.');
        err.code = 'DISCHARGE_NOT_READY';
        err.details = { blockers };
        throw err;
      }
    }

    const losDays = computeLos(admission.admitted_at, new Date());
    const targetStatus = discharge_type === 'lama' ? 'lama'
      : discharge_type === 'expired' ? 'expired'
      : 'discharged';

    const updated = await tx.admissions.update({
      where: { id: admission.id },
      data: {
        status: targetStatus,
        discharged_at: new Date(),
        discharge_type,
        discharge_summary: discharge_summary ?? null,
        updated_at: new Date(),
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    if (admission.bed_id) {
      // FOR UPDATE lock on the bed row before flipping it back to available.
      const bedCheck = await tx.$queryRaw`
        SELECT id, status FROM beds WHERE id = ${admission.bed_id} FOR UPDATE
      `;
      if (bedCheck.length && bedCheck[0].status === 'occupied') {
        await tx.beds.update({
          where: { id: admission.bed_id },
          data: {
            status: 'available',
            patient_id: null,
            patient_name: null,
            admitted_at: null,
            updated_at: new Date(),
          },
        });

        await tx.bed_transfers.create({
          data: {
            patient_uid: admission.patient_uid,
            admission_id: admission.id,
            // Pre-batch-55 raw SQL stored from_bed_id == to_bed_id == admission.bed_id
            // for discharge transfers; preserved here so audit history matches.
            from_bed_id: admission.bed_id,
            to_bed_id: admission.bed_id,
            reason: 'Discharge',
            transferred_by: dischargedBy,
          },
        });
      }
    }

    await tx.audit_logs.create({
      data: {
        uid: dischargedBy,
        action: 'DISCHARGE_PATIENT',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          discharge_type, los_days: losDays, patient_uid: admission.patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} discharged (${discharge_type}), LOS ${losDays} days`);
    return { ...updated, los_days: losDays };
  });
}

async function transferPatient(admissionId, toWardId, toBedId, reason, transferredBy) {
  if (!toBedId) throw AppError.badRequest('to_bed_id is required');
  if (!transferredBy) throw AppError.badRequest('transferredBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on the admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, patient_uid, bed_id, ward, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');

    const admission = admRows[0];
    if (!['admitted', 'transferred'].includes(admission.status)) {
      throw AppError.badRequest(`Cannot transfer admission in status: ${admission.status}`);
    }

    const fromBedId = admission.bed_id;

    // FOR UPDATE OF b — lock target bed only (not the joined ward row).
    // The original raw SQL used a LEFT JOIN to fetch the ward name; replaced
    // here with a typed lock-then-include via two queries so the join can be
    // expressed via Prisma.
    const targetBedLocked = await tx.$queryRaw`
      SELECT id, status, bed_number FROM beds WHERE id = ${toBedId} FOR UPDATE
    `;
    if (!targetBedLocked.length) throw AppError.notFound('Target bed not found');
    if (targetBedLocked[0].status !== 'available') {
      throw AppError.badRequest(`Target bed ${targetBedLocked[0].bed_number} is not available (current status: ${targetBedLocked[0].status})`);
    }

    const targetBed = await tx.beds.findUnique({
      where: { id: toBedId },
      select: {
        id: true,
        bed_number: true,
        wards: { select: { name: true } },
      },
    });
    const targetBedNumber = targetBed?.bed_number ?? targetBedLocked[0].bed_number;
    const targetWardName = targetBed?.wards?.name ?? null;

    // Resolve patient int id for beds FK
    const patientUser = await tx.users.findUnique({
      where: { uid: admission.patient_uid },
      select: { id: true, name: true },
    });
    const patientIntId = patientUser?.id ?? null;
    const patientName = patientUser?.name ?? null;

    if (fromBedId) {
      await tx.beds.update({
        where: { id: fromBedId },
        data: {
          status: 'available',
          patient_id: null,
          patient_name: null,
          admitted_at: null,
          updated_at: new Date(),
        },
      });
    }

    await tx.beds.update({
      where: { id: toBedId },
      data: {
        status: 'occupied',
        patient_id: patientIntId,
        patient_name: patientName,
        admitted_at: new Date(),
        assigned_at: new Date(),
        updated_at: new Date(),
      },
    });

    await tx.bed_transfers.create({
      data: {
        patient_uid: admission.patient_uid,
        admission_id: admissionId,
        from_bed_id: fromBedId ?? null,
        to_bed_id: toBedId,
        reason: reason || 'Transfer',
        transferred_by: transferredBy,
      },
    });

    const newWard = toWardId || targetWardName || admission.ward;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: {
        bed_id: toBedId,
        ward: newWard,
        bed_number: targetBedNumber,
        status: 'transferred',
        updated_at: new Date(),
      },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: transferredBy,
        action: 'TRANSFER_PATIENT',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          from_bed_id: fromBedId, to_bed_id: toBedId, to_ward: newWard, reason,
          patient_uid: admission.patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} transferred: bed ${fromBedId} -> ${toBedId}`);
    return updated;
  });
}

async function getActiveAdmissions(filters = {}) {
  const { ward, doctor, department, status } = filters;
  const listQuery = parseListQuery(filters, {
    defaultLimit: 20,
    maxLimit: 100,
    defaultSortBy: 'admitted_at'
  });

  const where = {};
  if (status) {
    where.status = status;
  } else {
    where.status = { in: ['admitted', 'transferred'] };
  }
  if (ward) where.ward = ward;
  if (department) where.department = department;
  if (doctor) {
    where.OR = [
      { admitting_doctor: doctor },
      { attending_doctor: doctor },
    ];
  }

  const [total, rows] = await Promise.all([
    prisma.admissions.count({ where }),
    prisma.admissions.findMany({
      where,
      select: {
        id: true,
        encounter_id: true,
        patient_uid: true,
        admitting_doctor: true,
        attending_doctor: true,
        department: true,
        ward: true,
        bed_id: true,
        bed_number: true,
        chief_complaint: true,
        admitting_diagnosis: true,
        admission_type: true,
        status: true,
        priority: true,
        code_status: true,
        allergies: true,
        admitted_at: true,
        expected_los_days: true,
      },
      orderBy: { admitted_at: 'desc' },
      take: listQuery.limit,
      skip: listQuery.offset,
    }),
  ]);

  // Enrich with users (patient name/phone) + beds.wards (bed_ward_name) in
  // bulk — avoids the N+1 you'd get with per-row Prisma includes when the
  // FK isn't declared (admissions has no relation to users in the schema).
  const patientUids = Array.from(new Set(rows.map((r) => r.patient_uid).filter(Boolean)));
  const bedIds = Array.from(new Set(rows.map((r) => r.bed_id).filter((id) => id != null)));

  const [patients, beds] = await Promise.all([
    patientUids.length
      ? prisma.users.findMany({
          where: { uid: { in: patientUids } },
          select: { uid: true, name: true, phone: true },
        })
      : [],
    bedIds.length
      ? prisma.beds.findMany({
          where: { id: { in: bedIds } },
          select: { id: true, wards: { select: { name: true } } },
        })
      : [],
  ]);

  const patientByUid = new Map(patients.map((p) => [p.uid, p]));
  const bedById = new Map(beds.map((b) => [b.id, b]));

  const admissions = rows.map((row) => {
    const patient = patientByUid.get(row.patient_uid);
    const bed = row.bed_id != null ? bedById.get(row.bed_id) : null;
    return {
      ...row,
      patient_name: patient?.name ?? null,
      patient_phone: patient?.phone ?? null,
      bed_ward_name: bed?.wards?.name ?? null,
    };
  });

  return {
    admissions,
    pagination: buildPagination(total, listQuery.page, listQuery.limit),
  };
}

async function getAdmissionDetail(admissionId, requestContext = {}) {
  const admission = await prisma.admissions.findUnique({
    where: { id: Number(admissionId) },
  });
  if (!admission) throw AppError.notFound('Admission not found');

  // Patient + bed/ward + admitting/attending doctor names in parallel.
  // The pre-batch-48 raw SQL joined `staff` on `uid`, but staff has no
  // `uid` (only user_id uuid) — batch 48 fixed that to join `users`,
  // which is what we use here. Doctors are users with role≥DOCTOR; we
  // only need the display name.
  const doctorUids = [admission.admitting_doctor, admission.attending_doctor]
    .filter(Boolean);
  const [patient, bed, doctors] = await Promise.all([
    admission.patient_uid
      ? prisma.users.findUnique({
          where: { uid: admission.patient_uid },
          select: { name: true, phone: true, gender: true, email: true, birthday: true },
        })
      : null,
    admission.bed_id != null
      ? prisma.beds.findUnique({
          where: { id: admission.bed_id },
          select: { wards: { select: { name: true } } },
        })
      : null,
    doctorUids.length
      ? prisma.users.findMany({
          where: { uid: { in: doctorUids } },
          select: { uid: true, name: true },
        })
      : [],
  ]);

  const doctorByUid = new Map(doctors.map((d) => [d.uid, d.name]));

  const row = {
    ...admission,
    patient_name: patient?.name ?? null,
    patient_phone: patient?.phone ?? null,
    patient_gender: patient?.gender ?? null,
    patient_email: patient?.email ?? null,
    patient_birthday: patient?.birthday ?? null,
    bed_ward_name: bed?.wards?.name ?? null,
    admitting_doctor_name: admission.admitting_doctor
      ? doctorByUid.get(admission.admitting_doctor) ?? null
      : null,
    attending_doctor_name: admission.attending_doctor
      ? doctorByUid.get(admission.attending_doctor) ?? null
      : null,
  };
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

  const rows = await prisma.admissions.findMany({
    where: { patient_uid: patientUid },
    select: {
      id: true,
      encounter_id: true,
      admitting_doctor: true,
      attending_doctor: true,
      department: true,
      ward: true,
      bed_id: true,
      bed_number: true,
      chief_complaint: true,
      admitting_diagnosis: true,
      admission_type: true,
      status: true,
      priority: true,
      code_status: true,
      admitted_at: true,
      discharged_at: true,
      discharge_type: true,
      expected_los_days: true,
    },
    orderBy: { admitted_at: 'desc' },
  });

  return rows.map((r) => ({ ...r, los_days: computeLos(r.admitted_at, r.discharged_at) }));
}

async function updateCodeStatus(admissionId, codeStatus, updatedBy) {
  if (!VALID_CODE_STATUSES.includes(codeStatus)) {
    throw AppError.badRequest(`Invalid code_status: ${codeStatus}`);
  }
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, code_status, patient_uid, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update code status for a non-active admission');
    }

    const previousStatus = admRows[0].code_status;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: { code_status: codeStatus, updated_at: new Date() },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: updatedBy,
        action: 'UPDATE_CODE_STATUS',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          previous: previousStatus, new: codeStatus, patient_uid: admRows[0].patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} code status changed: ${previousStatus} -> ${codeStatus}`);
    return updated;
  });
}

async function updateAttendingDoctor(admissionId, doctorUid, updatedBy) {
  if (!doctorUid) throw AppError.badRequest('doctor_uid is required');
  if (!updatedBy) throw AppError.badRequest('updatedBy is required');

  return prisma.$transaction(async (tx) => {
    // FOR UPDATE lock on admission row.
    const admRows = await tx.$queryRaw`
      SELECT id, attending_doctor, patient_uid, status
      FROM admissions WHERE id = ${admissionId} FOR UPDATE
    `;
    if (!admRows.length) throw AppError.notFound('Admission not found');
    if (!['admitted', 'transferred'].includes(admRows[0].status)) {
      throw AppError.badRequest('Cannot update attending doctor for a non-active admission');
    }

    const previousDoctor = admRows[0].attending_doctor;

    const updated = await tx.admissions.update({
      where: { id: admissionId },
      data: { attending_doctor: doctorUid, updated_at: new Date() },
      select: ADMISSION_RETURNING_SELECT,
    });

    await tx.audit_logs.create({
      data: {
        uid: updatedBy,
        action: 'UPDATE_ATTENDING_DOCTOR',
        resource: 'admission',
        resource_id: String(admissionId),
        metadata: {
          previous_doctor: previousDoctor, new_doctor: doctorUid, patient_uid: admRows[0].patient_uid,
        },
        ip_address: null,
      },
    });

    logger.info(`Admission #${admissionId} attending doctor changed: ${previousDoctor} -> ${doctorUid}`);
    return updated;
  });
}

async function getAdmissionStats(dateFrom, dateTo) {
  // Date filter for admissions.admitted_at — preserved bounds: [dateFrom, dateTo].
  const admittedAtFilter = {};
  if (dateFrom) admittedAtFilter.gte = new Date(dateFrom);
  if (dateTo) admittedAtFilter.lte = new Date(dateTo);
  const adWhere = Object.keys(admittedAtFilter).length
    ? { admitted_at: admittedAtFilter }
    : {};
  const dischargeWhere = Object.keys(admittedAtFilter).length
    ? { admitted_at: admittedAtFilter, discharge_type: { not: null } }
    : { discharge_type: { not: null } };

  // One scan to compute total/discharged/admitted/transferred counts and
  // avg LOS — Prisma aggregate can't do COUNT FILTER (...) so reduce in JS.
  const [allAdmissions, dischargeGroups, typeGroups, totalBeds, occupiedBeds] = await Promise.all([
    prisma.admissions.findMany({
      where: adWhere,
      select: { status: true, admitted_at: true, discharged_at: true },
    }),
    prisma.admissions.groupBy({
      by: ['discharge_type'],
      where: dischargeWhere,
      _count: { _all: true },
    }),
    prisma.admissions.groupBy({
      by: ['admission_type'],
      where: adWhere,
      _count: { _all: true },
    }),
    prisma.beds.count(),
    prisma.beds.count({ where: { status: 'occupied' } }),
  ]);

  let totalAdmissions = 0;
  let totalDischarged = 0;
  let currentlyAdmitted = 0;
  let currentlyTransferred = 0;
  const losDaysSamples = [];
  for (const a of allAdmissions) {
    totalAdmissions += 1;
    if (['discharged', 'lama', 'expired'].includes(a.status)) totalDischarged += 1;
    if (a.status === 'admitted') currentlyAdmitted += 1;
    if (a.status === 'transferred') currentlyTransferred += 1;
    if (a.discharged_at && a.admitted_at) {
      // Mirror the pre-batch-55 SQL: GREATEST(1, CEIL(epoch / 86400.0)).
      const epochSec = (new Date(a.discharged_at) - new Date(a.admitted_at)) / 1000;
      losDaysSamples.push(Math.max(1, Math.ceil(epochSec / 86400)));
    }
  }
  const avgLosDays = losDaysSamples.length
    ? Math.round((losDaysSamples.reduce((s, v) => s + v, 0) / losDaysSamples.length) * 10) / 10
    : null;

  // Discharge-type breakdown sorted by count desc, drop nulls (the WHERE
  // clause already excludes them but groupBy can still surface a null bucket
  // for empty result sets).
  const dischargeTypeBreakdown = dischargeGroups
    .filter((g) => g.discharge_type != null)
    .map((g) => ({ discharge_type: g.discharge_type, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const admissionTypeBreakdown = typeGroups
    .map((g) => ({ admission_type: g.admission_type, count: g._count._all }))
    .sort((a, b) => b.count - a.count);

  const occupancyRate = totalBeds > 0
    ? Math.round((occupiedBeds / totalBeds) * 100 * 100) / 100
    : 0;

  return {
    total_admissions: totalAdmissions,
    total_discharged: totalDischarged,
    avg_los_days: avgLosDays,
    currently_admitted: currentlyAdmitted,
    currently_transferred: currentlyTransferred,
    occupancy_rate: occupancyRate,
    total_beds: totalBeds,
    occupied_beds: occupiedBeds,
    discharge_type_breakdown: dischargeTypeBreakdown,
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
