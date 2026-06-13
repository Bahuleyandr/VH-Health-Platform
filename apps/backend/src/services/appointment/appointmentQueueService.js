import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';

const DEFAULT_TENANT_ID = '00000000-0000-4000-8000-000000000001';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cleanText(value, max = 120) {
  const text = value == null ? '' : String(value).trim();
  return text ? text.slice(0, max) : null;
}

function cleanUuid(value) {
  const text = cleanText(value, 40);
  return text && UUID_RE.test(text) ? text : null;
}

function cleanInt(value) {
  if (value == null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function dateParam(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const text = String(value).trim();
  if (!text) return null;
  return text.includes('T') ? text.split('T')[0] : text.slice(0, 10);
}

function compactQueue(row) {
  if (!row) return null;
  return {
    id: cleanInt(row.id ?? row.queue_id),
    queue_id: cleanInt(row.id ?? row.queue_id),
    queue_date: row.queue_date,
    queue_kind: row.queue_kind,
    queue_label: row.queue_label,
    status: row.status,
    department_id: cleanInt(row.department_id),
    department_name: row.department_name ?? null,
    doctor_id: cleanInt(row.doctor_id),
    doctor_uid: row.doctor_uid ?? null,
  };
}

export function appointmentQueueKindForAppointment(appointment = {}) {
  const visitType = cleanText(appointment.visit_type)?.toUpperCase() ?? '';
  const department = cleanText(appointment.department)?.toUpperCase() ?? '';
  const time = cleanText(appointment.appointment_time)?.toLowerCase() ?? '';
  if (
    visitType === 'EMERGENCY' ||
    /\b(ER|EMERGENCY|CASUALTY)\b/.test(department)
  ) {
    return 'emergency';
  }
  if (time === 'walk-in' || time === 'walk in') return 'walk_in';
  if (cleanInt(appointment.doctor_id)) return 'doctor';
  if (cleanText(appointment.department)) return 'department';
  return 'op';
}

async function resolveDoctorContext(db, doctorId, tenantId, fallbackDepartment) {
  const id = cleanInt(doctorId);
  if (!id) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT
        u.id,
        u.uid,
        u.name,
        COALESCE(dept.id, dept_by_name.id) AS department_id,
        COALESCE(dept.name, d.department, dept_by_name.name, $3::text) AS department_name
       FROM users u
       LEFT JOIN doctors d ON d.user_id = u.id
       LEFT JOIN departments dept ON dept.id = d.department_id
       LEFT JOIN departments dept_by_name
         ON LOWER(dept_by_name.name) = LOWER(COALESCE($3::text, d.department, ''))
      WHERE u.id = $1::int
        AND ($2::uuid IS NULL OR u.tenant_id = $2::uuid)
      ORDER BY CASE WHEN u.role = 'DOCTOR' THEN 0 ELSE 1 END
      LIMIT 1`,
    id,
    tenantId,
    cleanText(fallbackDepartment),
  );
  return rows[0] ?? null;
}

async function resolveDepartmentContext(db, department) {
  const name = cleanText(department);
  if (!name) return null;
  const rows = await db.$queryRawUnsafe(
    `SELECT id, name
       FROM departments
      WHERE LOWER(name) = LOWER($1)
      ORDER BY is_active DESC, id ASC
      LIMIT 1`,
    name,
  );
  return rows[0] ?? { id: null, name };
}

export async function ensureAppointmentQueueForAppointment(
  db,
  appointment,
  { actorUid = null, source = 'appointment' } = {},
) {
  const appointmentId = cleanInt(appointment?.id);
  const tenantId = cleanUuid(appointment?.tenant_id) || DEFAULT_TENANT_ID;
  const queueDate = dateParam(appointment?.appointment_date);
  if (!appointmentId || !queueDate) return null;

  const doctorId = cleanInt(appointment?.doctor_id);
  const doctorContext = await resolveDoctorContext(
    db,
    doctorId,
    tenantId,
    appointment?.department,
  );
  const departmentContext = await resolveDepartmentContext(
    db,
    cleanText(appointment?.department) || doctorContext?.department_name,
  );

  const departmentId = cleanInt(departmentContext?.id ?? doctorContext?.department_id);
  const departmentName = cleanText(
    departmentContext?.name ?? doctorContext?.department_name ?? appointment?.department,
  );
  const doctorUid = cleanUuid(doctorContext?.uid);
  const queueKind = appointmentQueueKindForAppointment(appointment);
  const queueLabel = cleanText(
    [
      doctorContext?.name,
      departmentName,
      queueKind === 'walk_in' ? 'Walk-in' : null,
      queueKind === 'emergency' ? 'Emergency' : null,
    ].filter(Boolean).join(' - ') || 'OP Queue',
    255,
  );
  const changedBy = cleanUuid(actorUid);
  const metadata = JSON.stringify({
    source,
    first_appointment_id: appointmentId,
  });

  const rows = await db.$queryRawUnsafe(
    `WITH existing AS (
       SELECT
         id, queue_date, queue_kind, department_id, department_name,
         doctor_id, doctor_uid, queue_label, status, FALSE AS created_now
       FROM appointment_queues
       WHERE tenant_id = $1::uuid
         AND queue_date = $2::date
         AND queue_kind = $3
         AND COALESCE(facility_id, 0) = 0
         AND COALESCE(department_id, 0) = COALESCE($4::int, 0)
         AND COALESCE(doctor_id, 0) = COALESCE($5::int, 0)
         AND status IN ('draft', 'open', 'paused')
       ORDER BY id ASC
       LIMIT 1
     ),
     inserted AS (
       INSERT INTO appointment_queues (
         tenant_id, queue_date, queue_kind, department_id, department_name,
         doctor_id, doctor_uid, queue_label, status, metadata,
         created_by, updated_by, created_at, updated_at
       )
       SELECT
         $1::uuid, $2::date, $3, $4::int, $6,
         $5::int, $7::uuid, $8, 'open', $9::jsonb,
         $10::uuid, $10::uuid, NOW(), NOW()
       WHERE NOT EXISTS (SELECT 1 FROM existing)
       RETURNING
         id, queue_date, queue_kind, department_id, department_name,
         doctor_id, doctor_uid, queue_label, status, TRUE AS created_now
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT * FROM existing
     LIMIT 1`,
    tenantId,
    queueDate,
    queueKind,
    departmentId,
    doctorId,
    departmentName,
    doctorUid,
    queueLabel,
    metadata,
    changedBy,
  );

  const queue = rows[0] ?? null;
  if (!queue?.id) return null;

  await db.$executeRawUnsafe(
    `UPDATE appointments
        SET queue_id = $1::int,
            updated_at = NOW()
      WHERE id = $2::int
        AND tenant_id = $3::uuid
        AND (queue_id IS NULL OR queue_id <> $1::int)`,
    queue.id,
    appointmentId,
    tenantId,
  );

  if (queue.created_now === true) {
    await db.$executeRawUnsafe(
      `INSERT INTO appointment_queue_status_history (
         tenant_id, appointment_queue_id, from_status, to_status,
         reason, changed_by, metadata, created_by, updated_by,
         created_at, updated_at
       )
       VALUES (
         $1::uuid, $2::int, NULL, 'open',
         $3, $4::uuid, $5::jsonb, $4::uuid, $4::uuid,
         NOW(), NOW()
       )`,
      tenantId,
      queue.id,
      `Created from ${source}`,
      changedBy,
      metadata,
    );
  }

  return compactQueue(queue);
}

export async function loadAppointmentQueueMapForAppointmentIds(db, appointmentIds) {
  const ids = [...new Set((appointmentIds || []).map(cleanInt).filter(Boolean))];
  if (ids.length === 0) return new Map();

  const rows = await db.$queryRawUnsafe(
    `SELECT
        a.id AS appointment_id,
        a.queue_id,
        q.queue_date,
        q.queue_kind,
        q.queue_label,
        q.status,
        q.department_id,
        q.department_name,
        q.doctor_id,
        q.doctor_uid
       FROM appointments a
       LEFT JOIN appointment_queues q ON q.id = a.queue_id
      WHERE a.id = ANY($1::int[])`,
    ids,
  );

  const byAppointment = new Map();
  for (const row of rows) {
    const appointmentId = cleanInt(row.appointment_id);
    if (!appointmentId) continue;
    const queue = row.queue_id ? compactQueue({ ...row, id: row.queue_id }) : null;
    byAppointment.set(appointmentId, {
      queue_id: cleanInt(row.queue_id),
      appointment_queue: queue,
    });
  }
  return byAppointment;
}

export async function attachAppointmentQueues(rows, db = prisma) {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  try {
    const queueMap = await loadAppointmentQueueMapForAppointmentIds(
      db,
      rows.map((row) => row?.id),
    );
    return rows.map((row) => {
      const queueInfo = queueMap.get(cleanInt(row?.id));
      if (!queueInfo) return row;
      return {
        ...row,
        queue_id: queueInfo.queue_id,
        appointment_queue: queueInfo.appointment_queue,
      };
    });
  } catch (err) {
    logger.warn('Appointment queue enrichment failed:', err?.message);
    return rows;
  }
}
