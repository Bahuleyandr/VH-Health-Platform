// src/services/appointment/appointmentService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { composeVisitNo, deptPrefix } from '../../controllers/appointment/appointmentWorkflowController.js';
import { resolveDoctorRef } from '../doctor/doctorRefService.js';

export class AppointmentService {
  async validateUser(userId, requiredRole = null, tenantId = null) {
    try {
      const where = { id: parseInt(userId) };
      if (requiredRole) where.role = requiredRole;
      if (tenantId) where.tenant_id = tenantId;
      return prisma.users.findFirst({
        where,
        select: { id: true, uid: true, name: true, phone: true, email: true, role: true },
      });
    } catch (error) {
      logger.error('Error validating user:', error);
      throw error;
    }
  }

  async validateDoctor(doctorId, tenantId = null) {
    try {
      return await resolveDoctorRef(prisma, doctorId, { tenantId });
    } catch (error) {
      logger.error('Error validating doctor:', error);
      throw error;
    }
  }

  async checkConflict(doctorId, appointmentDate, appointmentTime, excludeId = null, tenantId = null) {
    try {
      let rows;
      if (excludeId) {
        rows = await prisma.$queryRaw`
          SELECT id FROM appointments
          WHERE doctor_id = ${parseInt(doctorId)}
            AND DATE(appointment_date) = DATE(${appointmentDate}::date)
            AND appointment_time = ${appointmentTime}
            AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
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
            AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
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
      tenant_id = null,
      created_by = null,
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
    const hasDoctorId = doctor_id !== undefined && doctor_id !== null && String(doctor_id).trim() !== '';

    try {
      return await prisma.$transaction(async (tx) => {
        // Resolve patient phone and, when specified, doctor routing metadata.
        const [pRows, resolvedDoctor] = await Promise.all([
          tx.$queryRaw`
            SELECT id, phone, name
              FROM users
             WHERE id = ${parseInt(patient_id)}
               AND (${tenant_id}::uuid IS NULL OR tenant_id = ${tenant_id}::uuid)
             LIMIT 1
          `,
          hasDoctorId
            ? resolveDoctorRef(tx, doctor_id, { tenantId: tenant_id })
            : Promise.resolve(null),
        ]);
        if (!pRows[0]) {
          const err = new Error('Patient not found');
          err.statusCode = 400;
          throw err;
        }
        const patientPhone = pRows[0]?.phone ?? '';
        const patientName = pRows[0]?.name ?? null;
        if (hasDoctorId && !resolvedDoctor?.id) {
          const err = new Error('Doctor not found');
          err.statusCode = 400;
          throw err;
        }
        const resolvedDoctorId = resolvedDoctor?.id ?? null;
        const doctorName = resolvedDoctor?.name ?? '';
        const resolvedDepartment = department
          ? String(department).trim().slice(0, 100)
          : (resolvedDoctor?.department ? String(resolvedDoctor.department).trim().slice(0, 100) : null);
        if (!resolvedDoctorId && !resolvedDepartment) {
          const err = new Error('Select a doctor or department');
          err.statusCode = 400;
          throw err;
        }

        // Lock conflicting rows
        const conflict = resolvedDoctorId
          ? await tx.$queryRaw`
              SELECT id FROM appointments
              WHERE doctor_id = ${parseInt(resolvedDoctorId, 10)}
                AND DATE(appointment_date) = DATE(${appointment_date}::date)
                AND appointment_time = ${appointment_time}
                AND (${tenant_id}::uuid IS NULL OR tenant_id = ${tenant_id}::uuid)
                AND status NOT IN ('CANCELLED', 'NO_SHOW')
              FOR UPDATE
            `
          : [];

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
            reason, notes, status, department, visit_type, created_by,
            tenant_id, created_at, updated_at
          ) VALUES (
            ${patientPhone}, ${parseInt(patient_id)}, ${patientName},
            ${resolvedDoctorId ? parseInt(resolvedDoctorId, 10) : null}, ${doctorName},
            ${appointment_date}::date, ${appointment_time},
            ${reason ?? null}, ${notes ?? null},
            ${APPOINTMENT_CONFIG.STATUSES.SCHEDULED}, ${resolvedDepartment}, ${resolvedVisitType},
            ${created_by || null}::uuid,
            COALESCE(${tenant_id}::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
            NOW(), NOW()
          )
          RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time, status, reason, notes, department, visit_type,
            tenant_id, created_at, updated_at
        `;

        return rows[0];
      });
    } catch (error) {
      logger.error('Error creating appointment:', error);
      throw error;
    }
  }

  async updateAppointment(id, updateData, tenantId = null, updatedBy = null) {
    const { appointment_date, appointment_time, reason, notes, visit_type } = updateData;
    try {
      const rows = await prisma.$queryRaw`
        UPDATE appointments SET
          appointment_date = COALESCE(${appointment_date ?? null}::date, appointment_date),
          appointment_time = COALESCE(${appointment_time ?? null}, appointment_time),
          reason           = COALESCE(${reason ?? null}, reason),
          notes            = COALESCE(${notes ?? null}, notes),
          visit_type       = COALESCE(${visit_type ?? null}, visit_type),
          updated_by       = COALESCE(${updatedBy ?? null}::uuid, updated_by),
          updated_at       = NOW()
        WHERE id = ${parseInt(id)}
          AND (${tenantId}::uuid IS NULL OR tenant_id = ${tenantId}::uuid)
        RETURNING id, uid, phone, patient_name, doctor_name, appointment_date,
          appointment_time, status, reason, notes, visit_type, tenant_id, created_at, updated_at
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

  async getAppointmentById(id, tenantId = null) {
    try {
      // Duplicate of AppointmentQueryService.getAppointmentById — both
      // services export this method under slightly different consumer
      // paths. Delegating here keeps the flattening logic in one place.
      const { default: queryService } = await import('./appointmentQueryService.js');
      return queryService.getAppointmentById(id, tenantId);
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
