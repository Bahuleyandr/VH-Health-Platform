// src/services/appointment/appointmentService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { composeVisitNo, deptPrefix } from '../../controllers/appointment/appointmentWorkflowController.js';

export class AppointmentService {
  async validateUser(userId, requiredRole = null) {
    try {
      const where = { id: parseInt(userId) };
      if (requiredRole) where.role = requiredRole;
      return prisma.users.findFirst({
        where,
        select: { id: true, uid: true, name: true, phone: true, email: true, role: true },
      });
    } catch (error) {
      logger.error('Error validating user:', error);
      throw error;
    }
  }

  async validateDoctor(doctorId) {
    try {
      const id = parseInt(doctorId, 10);
      const rows = await prisma.$queryRaw`
        SELECT id, name, role
        FROM (
          SELECT u.id, u.name, u.role, 0 AS sort_order
          FROM users u
          WHERE u.id = ${id}
            AND u.role = 'DOCTOR'
            AND u.is_active = true
          UNION ALL
          SELECT u.id AS id,
                 u.name AS name,
                 'DOCTOR'::text AS role,
                 1 AS sort_order
          FROM doctors d
          JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR' AND u.is_active = true
          WHERE d.is_active = true
            AND (u.id = ${id} OR d.id = ${id})
        ) candidates
        ORDER BY sort_order
        LIMIT 1
      `;
      return rows[0] || null;
    } catch (error) {
      logger.error('Error validating doctor:', error);
      throw error;
    }
  }

  async checkConflict(doctorId, appointmentDate, appointmentTime, excludeId = null) {
    try {
      let rows;
      if (excludeId) {
        rows = await prisma.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctorId)}
            AND DATE(appointment_date) = DATE(${appointmentDate}::date)
            AND appointment_time = ${appointmentTime}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
            AND id != ${parseInt(excludeId)}
          LIMIT 1
        `;
      } else {
        rows = await prisma.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctorId)}
            AND DATE(appointment_date) = DATE(${appointmentDate}::date)
            AND appointment_time = ${appointmentTime}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
          LIMIT 1
        `;
      }
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error checking appointment conflict:', error);
      throw error;
    }
  }

  async createAppointment(appointmentData) {
    const {
      patient_id,
      doctor_id,
      appointment_date,
      appointment_time,
      reason,
      notes = null,
      department = null,
      visit_type = null,
    } = appointmentData;
    const visitType = visit_type
      ? String(visit_type).trim().toUpperCase()
      : null;
    const allowedVisitTypes = new Set([
      'NEW',
      'FOLLOW_UP',
      'EMERGENCY',
      'TELE',
      'LAB_ONLY',
      'PAEDIATRIC_OPD',
    ]);
    const resolvedVisitType = allowedVisitTypes.has(visitType) ? visitType : null;

    try {
      return await prisma.$transaction(async (tx) => {
        // Resolve patient phone + doctor name for the NOT NULL columns on appointments.
        const [pRows, dRows] = await Promise.all([
          tx.$queryRaw`SELECT id, phone, name FROM users WHERE id = ${parseInt(patient_id)}`,
          tx.$queryRaw`
            SELECT id, name, department
            FROM (
              -- Highest priority: input matches a doctors.id directly.
              -- This is the "doctor picker" semantic — the admin UI's
              -- dropdown surfaces doctors.id, so when both interpretations
              -- collide (the input also happens to equal some other
              -- doctor's users.id), the picker wins.
              SELECT u.id AS id,
                     u.name AS name,
                     COALESCE(dept.name, d.department) AS department,
                     0 AS sort_order
              FROM doctors d
              JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR' AND u.is_active = true
              LEFT JOIN departments dept ON dept.id = d.department_id
              WHERE d.is_active = true
                AND d.id = ${parseInt(doctor_id)}
              UNION ALL
              -- Second priority: input is a users.id with role=DOCTOR
              -- (covers doctors who haven't been migrated to the doctors
              -- profile table yet, plus the common-case users.id input).
              SELECT u.id, u.name, COALESCE(dept.name, doc.department) AS department, 1 AS sort_order
              FROM users u
              LEFT JOIN doctors doc ON doc.user_id = u.id AND doc.is_active = true
              LEFT JOIN departments dept ON dept.id = doc.department_id
              WHERE u.id = ${parseInt(doctor_id)}
                AND u.role = 'DOCTOR'
                AND u.is_active = true
              UNION ALL
              -- Fallback: input matches a users.id reachable via a doctors
              -- profile (kept for legacy callers).
              SELECT u.id AS id,
                     u.name AS name,
                     COALESCE(dept.name, d.department) AS department,
                     2 AS sort_order
              FROM doctors d
              JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR' AND u.is_active = true
              LEFT JOIN departments dept ON dept.id = d.department_id
              WHERE d.is_active = true
                AND u.id = ${parseInt(doctor_id)}
            ) candidates
            ORDER BY sort_order
            LIMIT 1
          `,
        ]);
        const patientPhone = pRows[0]?.phone ?? '';
        const patientName = pRows[0]?.name ?? null;
        if (!dRows[0]?.id) {
          const err = new Error('Doctor not found');
          err.statusCode = 400;
          throw err;
        }
        const resolvedDoctorId = dRows[0].id;
        const doctorName = dRows[0]?.name ?? '';
        const resolvedDepartment = department
          ? String(department).trim().slice(0, 100)
          : (dRows[0]?.department ? String(dRows[0].department).trim().slice(0, 100) : null);

        // Lock conflicting rows
        const conflict = await tx.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(resolvedDoctorId)}
            AND DATE(appointment_date) = DATE(${appointment_date}::date)
            AND appointment_time = ${appointment_time}
            AND status NOT IN ('CANCELLED', 'NO_SHOW')
          FOR UPDATE
        `;

        if (conflict.length > 0) {
          const err = new Error('Slot no longer available');
          err.isConflict = true;
          err.conflictingId = conflict[0].id;
          throw err;
        }

        const rows = await tx.$queryRaw`
          INSERT INTO appointments (
            phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time,
            reason, notes, status, department, visit_type, created_at, updated_at
          ) VALUES (
            ${patientPhone}, ${parseInt(patient_id)}, ${patientName},
            ${parseInt(resolvedDoctorId)}, ${doctorName},
            ${appointment_date}::date, ${appointment_time},
            ${reason ?? null}, ${notes ?? null},
            ${APPOINTMENT_CONFIG.STATUSES.SCHEDULED}, ${resolvedDepartment}, ${resolvedVisitType}, NOW(), NOW()
          )
          RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time, status, reason, notes, department, visit_type, created_at, updated_at
        `;

        return rows[0];
      });
    } catch (error) {
      logger.error('Error creating appointment:', error);
      throw error;
    }
  }

  async updateAppointment(id, updateData) {
    const { appointment_date, appointment_time, reason, notes, visit_type } = updateData;
    try {
      const rows = await prisma.$queryRaw`
        UPDATE appointments SET
          appointment_date = COALESCE(${appointment_date ?? null}::date, appointment_date),
          appointment_time = COALESCE(${appointment_time ?? null}, appointment_time),
          reason           = COALESCE(${reason ?? null}, reason),
          notes            = COALESCE(${notes ?? null}, notes),
          visit_type       = COALESCE(${visit_type ?? null}, visit_type),
          updated_at       = NOW()
        WHERE id = ${parseInt(id)}
        RETURNING id, uid, phone, patient_name, doctor_name, appointment_date,
          appointment_time, status, reason, notes, visit_type, created_at, updated_at
      `;
      return rows[0];
    } catch (error) {
      logger.error('Error updating appointment:', error);
      throw error;
    }
  }

  async updateAppointmentStatus(id, status, notes = null, _updatedBy = null) {
    try {
      const apptId = parseInt(id);
      const normalizedStatus = String(status || '').toUpperCase();

      // E-10 — RETURNING from the appointments row alone returned NULL for
      // patient_name when the row's denormalized patient_name was never
      // populated (walk-in paths don't write it). Fetch via a join after
      // the UPDATE so the response always carries the canonical user name.
      // Finding: 2026-05-08-follow-up-opd-doctor-status-update-loses-patient-name.
      //
      // When the transition is to CONFIRMED, finish what the dedicated
      // POST /:id/confirm path would have done: backfill token_number,
      // confirmed_at, department, and (for EMER) an emergency_visits
      // row so the ED queue / triage / MLC flow can pick the patient up.
      // Without this, a fallback `PUT /:id/status` confirms an
      // emergency walk-in but leaves the visit unrouted — see finding
      // 2026-05-10-dynamic-acute-abdomen-receptionist-fallback-no-visit-number.
      if (normalizedStatus === 'CONFIRMED') {
        await prisma.$transaction(async (tx) => {
          const apptRows = await tx.$queryRawUnsafe(
            `SELECT id, patient_id, doctor_id, appointment_date,
                    token_number, confirmed_at, department, status, visit_type
               FROM appointments WHERE id = $1::int FOR UPDATE`,
            apptId,
          );
          if (!apptRows.length) return;
          const a = apptRows[0];

          // Resolve department from the doctor when the row was booked via
          // the generic /book path that doesn't carry department.
          let resolvedDept = a.department;
          if (!resolvedDept && a.doctor_id) {
            const docRows = await tx.$queryRawUnsafe(
              `SELECT COALESCE(dept.name, doc.department) AS department
                 FROM doctors doc
                 LEFT JOIN departments dept ON dept.id = doc.department_id
                WHERE doc.id = $1::int OR doc.user_id = $1::int
                LIMIT 1`,
              parseInt(a.doctor_id, 10),
            );
            const candidate = docRows[0]?.department;
            if (candidate) resolvedDept = String(candidate).trim().slice(0, 100);
          }

          // Generate a department-scoped token only when missing; preserve
          // any token the appointment already carries (e.g. from a prior
          // /confirm call) so we don't shift the queue.
          let tokenNumber = a.token_number;
          if (!tokenNumber) {
            const targetDate = a.appointment_date;
            const tokenRows = await tx.$queryRawUnsafe(
              `SELECT COALESCE(MAX(NULLIF(token_number, '')::int), 0) + 1 AS next_token
                 FROM appointments
                WHERE DATE(appointment_date) = DATE($1)
                  AND confirmed_at IS NOT NULL
                  AND token_number IS NOT NULL
                  AND token_number ~ '^[0-9]+$'
                  AND COALESCE(department, '') = COALESCE($2::text, '')`,
              targetDate, resolvedDept || null,
            );
            tokenNumber = String(parseInt(tokenRows[0].next_token));
          }

          await tx.$executeRawUnsafe(
            `UPDATE appointments SET
               status        = 'CONFIRMED',
               notes         = CASE
                                 WHEN $2::text IS NOT NULL
                                 THEN COALESCE(notes || ' | ', '') || $2::text
                                 ELSE notes
                               END,
               token_number  = COALESCE(token_number, $3),
               confirmed_at  = COALESCE(confirmed_at, NOW()),
               department    = COALESCE(department, $4),
               updated_at    = NOW()
             WHERE id = $1::int`,
            apptId, notes ?? null, tokenNumber, resolvedDept || null,
          );

          // Mirror registerWalkIn — emergency confirmations need an
          // emergency_visits row so the ED queue, MLC flow, and triage
          // workflow can pick the patient up. Idempotent on
          // (tenant_id, visit_number). Tenant context isn't threaded
          // through this service path, so fall back to the platform
          // default tenant (the same default registerWalkIn uses).
          if (deptPrefix(resolvedDept) === 'EMER' || String(a.visit_type || '').toUpperCase() === 'EMERGENCY') {
            const patientRow = await tx.$queryRawUnsafe(
              'SELECT uid FROM users WHERE id = $1::int LIMIT 1',
              parseInt(a.patient_id, 10),
            );
            const patientUid = patientRow[0]?.uid ?? null;
            if (patientUid) {
              const visitNo = composeVisitNo({
                department: resolvedDept,
                date: a.appointment_date || new Date(),
                tokenNumber,
              });
              const tenantId = '00000000-0000-4000-8000-000000000001';
              await tx.$executeRawUnsafe(
                `INSERT INTO emergency_visits
                   (tenant_id, visit_number, patient_uid, arrival_mode,
                    chief_complaint, status)
                 VALUES ($1::uuid, $2, $3::uuid, 'walk_in', $4, 'arriving')
                 ON CONFLICT (tenant_id, visit_number) DO NOTHING`,
                tenantId, visitNo, patientUid,
                'Confirmed via /status fallback',
              );
            }
          }
        });
      } else {
        await prisma.$executeRawUnsafe(
          `UPDATE appointments SET
             status     = $1,
             notes      = CASE
                            WHEN $2::text IS NOT NULL
                            THEN COALESCE(notes || ' | ', '') || $2::text
                            ELSE notes
                          END,
             updated_at = NOW()
           WHERE id = $3`,
          status, notes ?? null, apptId,
        );
      }

      const rows = await prisma.$queryRawUnsafe(
        `SELECT a.id, a.uid, a.phone, a.patient_id, a.doctor_id,
                COALESCE(NULLIF(a.patient_name, ''), p.name) AS patient_name,
                COALESCE(NULLIF(a.doctor_name, ''), d.name) AS doctor_name,
                a.appointment_date, a.appointment_time, a.status, a.notes,
                a.token_number, a.confirmed_at, a.department,
                a.created_at, a.updated_at, a.visit_type
           FROM appointments a
           LEFT JOIN users p ON p.id = a.patient_id
           LEFT JOIN users d ON d.id = a.doctor_id
          WHERE a.id = $1
          LIMIT 1`,
        apptId,
      );
      return rows[0];
    } catch (error) {
      logger.error('Error updating appointment status:', error);
      throw error;
    }
  }

  async getAppointmentById(id) {
    try {
      // Duplicate of AppointmentQueryService.getAppointmentById — both
      // services export this method under slightly different consumer
      // paths. Delegating here keeps the flattening logic in one place.
      const { default: queryService } = await import('./appointmentQueryService.js');
      return queryService.getAppointmentById(id);
    } catch (error) {
      logger.error('Error getting appointment by ID:', error);
      throw error;
    }
  }

  async cancelAppointment(id, cancelledBy) {
    try {
      return await this.updateAppointmentStatus(
        id, APPOINTMENT_CONFIG.STATUSES.CANCELLED,
        `Cancelled by ${cancelledBy}`
      );
    } catch (error) {
      logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }
}

export default new AppointmentService();
