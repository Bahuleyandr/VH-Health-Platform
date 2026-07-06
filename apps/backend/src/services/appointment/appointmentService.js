// src/services/appointment/appointmentService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { composeVisitNo, deptPrefix } from '../../controllers/appointment/appointmentWorkflowController.js';
import { resolveDoctorRef } from '../doctor/doctorRefService.js';
import { ensureAppointmentQueueForAppointment } from './appointmentQueueService.js';
import { populateAppointmentCareTeam } from '../security/careTeamPopulationService.js';

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
            AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
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
            AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
          LIMIT 1
        `;
      }
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error checking appointment conflict:', error);
      throw error;
    }
  }

  async checkNearSlotConflict(doctorId, appointmentDate, appointmentTime, excludeId = null, tenantId = null) {
    try {
      if (!doctorId || !appointmentDate || !appointmentTime) return null;
      const rows = await prisma.$queryRawUnsafe(
        `SELECT id, appointment_time
           FROM appointments
          WHERE doctor_id = $1::int
            AND DATE(appointment_date) = DATE($2::date)
            AND ($5::uuid IS NULL OR tenant_id = $5::uuid)
            AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
            AND id <> COALESCE($4::int, 0)
            AND appointment_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
            AND $3::text ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
            AND appointment_time::time < ($3::time + ($6::int * INTERVAL '1 minute'))
            AND (appointment_time::time + ($6::int * INTERVAL '1 minute')) > $3::time
          ORDER BY appointment_time::time ASC
          LIMIT 1`,
        parseInt(doctorId, 10),
        appointmentDate,
        appointmentTime,
        excludeId ? parseInt(excludeId, 10) : null,
        tenantId,
        APPOINTMENT_CONFIG.APPOINTMENT_DURATION,
      );
      return rows.length > 0 ? rows[0] : null;
    } catch (error) {
      logger.error('Error checking near-slot appointment conflict:', error);
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
    const allowedVisitTypes = new Set(APPOINTMENT_CONFIG.VISIT_TYPES);
    const resolvedVisitType = allowedVisitTypes.has(visitType) ? visitType : null;
    const hasDoctorId = doctor_id !== undefined && doctor_id !== null && String(doctor_id).trim() !== '';

    // Captured from the booking tx for the post-commit CareTeam ABAC hook.
    let bookedPatientUid = null;
    let bookedDoctorUid = null;
    let bookedDoctorId = null;
    try {
      const bookingResult = await setTenantTx(requireTenantId(tenant_id), async (tx) => {
        // Resolve patient phone and, when specified, doctor routing metadata.
        const [pRows, resolvedDoctor] = await Promise.all([
          tx.$queryRaw`
            SELECT id, uid, phone, name
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
        bookedPatientUid = pRows[0]?.uid ?? null;
        bookedDoctorUid = resolvedDoctor?.uid ?? null;
        bookedDoctorId = resolvedDoctor?.id ?? null;
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
                AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
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

        const appointment = rows[0];
        const queue = await ensureAppointmentQueueForAppointment(tx, appointment, {
          actorUid: created_by,
          source: 'book',
        });

        return {
          ...appointment,
          queue_id: queue?.id ?? null,
          appointment_queue: queue,
        };
      });

      // CareTeam ABAC Phase 2 hook #2 (best-effort, post-commit) — materialise
      // the consulting/booked doctor onto an active `op` care team for this
      // patient/appointment so the ABAC engine's care-team relationship check
      // and the shadow-mode audit signal are meaningful. Idempotent +
      // self-contained: it swallows every error internally and MUST NEVER block
      // or fail the booking. Only fires when both a patient uid and a doctor
      // ref were resolved (department-only bookings have no doctor to add).
      if (bookedPatientUid && (bookedDoctorUid || bookedDoctorId)) {
        await populateAppointmentCareTeam({
          appointment: bookingResult,
          appointmentId: bookingResult?.id ?? null,
          tenantId: requireTenantId(bookingResult?.tenant_id || tenant_id),
          patientUid: bookedPatientUid,
          doctorUid: bookedDoctorUid,
          doctorId: bookedDoctorId,
          doctorRole: 'DOCTOR',
          createdBy: created_by,
        });
      }

      return bookingResult;
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

  async rescheduleAppointmentInPlace(id, rescheduleData, options = {}) {
    const {
      appointment_date,
      appointment_time,
      doctor_id,
      notes = null,
    } = rescheduleData;
    const {
      tenantId = null,
      actorUid = null,
      actorId = null,
      actorRole = null,
    } = options;
    const apptId = parseInt(id, 10);
    const targetTenantId = requireTenantId(tenantId);
    let updatedPatientUid = null;
    let updatedDoctorUid = null;
    let updatedDoctorId = null;

    try {
      const updated = await setTenantTx(targetTenantId, async (tx) => {
        const currentRows = await tx.$queryRawUnsafe(
          `SELECT a.id, a.uid, a.phone, a.patient_id, p.uid AS patient_uid,
                  COALESCE(NULLIF(a.patient_name, ''), p.name) AS patient_name,
                  a.doctor_id, d.uid AS doctor_uid,
                  COALESCE(NULLIF(a.doctor_name, ''), d.name) AS doctor_name,
                  a.appointment_date, a.appointment_time, a.status, a.reason,
                  a.notes, a.department, a.visit_type, a.tenant_id
             FROM appointments a
             LEFT JOIN users p ON p.id = a.patient_id
            LEFT JOIN users d ON d.id = a.doctor_id
           WHERE a.id = $1::int
             AND a.tenant_id = $2::uuid
           FOR UPDATE OF a`,
          apptId,
          targetTenantId,
        );
        if (!currentRows.length) {
          const err = new Error('Appointment not found');
          err.statusCode = 404;
          throw err;
        }

        const current = currentRows[0];
        const prevStatus = String(current.status || 'SCHEDULED').toUpperCase();
        if (['CANCELLED', 'NO_SHOW', 'COMPLETED', 'RESCHEDULED', 'IN_PROGRESS'].includes(prevStatus)) {
          const err = new Error(`Cannot reschedule an appointment with status ${prevStatus}`);
          err.statusCode = 400;
          throw err;
        }

        let resolvedDoctor = null;
        if (doctor_id !== undefined && doctor_id !== null && String(doctor_id).trim() !== '') {
          resolvedDoctor = await resolveDoctorRef(tx, doctor_id, { tenantId: targetTenantId });
          if (!resolvedDoctor?.id) {
            const err = new Error('Doctor not found');
            err.statusCode = 400;
            throw err;
          }
        }

        const targetDoctorId = resolvedDoctor?.id ?? current.doctor_id ?? null;
        const targetDoctorName = resolvedDoctor?.name ?? current.doctor_name ?? null;
        const targetDepartment = resolvedDoctor?.department ?? current.department ?? null;

        if (targetDoctorId) {
          const conflictRows = await tx.$queryRawUnsafe(
            `SELECT id, appointment_time
               FROM appointments
              WHERE doctor_id = $1::int
                AND DATE(appointment_date) = DATE($2::date)
                AND tenant_id = $5::uuid
                AND status NOT IN ('CANCELLED', 'NO_SHOW', 'RESCHEDULED')
                AND id <> $4::int
                AND appointment_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
                AND $3::text ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
                AND appointment_time::time < ($3::time + ($6::int * INTERVAL '1 minute'))
                AND (appointment_time::time + ($6::int * INTERVAL '1 minute')) > $3::time
              ORDER BY appointment_time::time ASC
              LIMIT 1
              FOR UPDATE`,
            parseInt(targetDoctorId, 10),
            appointment_date,
            appointment_time,
            apptId,
            targetTenantId,
            APPOINTMENT_CONFIG.APPOINTMENT_DURATION,
          );
          if (conflictRows.length) {
            const err = new Error('Time slot already booked');
            err.statusCode = 409;
            err.conflictingId = conflictRows[0].id;
            err.conflictingTime = conflictRows[0].appointment_time;
            throw err;
          }
        }

        const auditReason = notes
          ? `Rescheduled to ${appointment_date} ${appointment_time}: ${notes}`
          : `Rescheduled to ${appointment_date} ${appointment_time}`;

        const rows = await tx.$queryRawUnsafe(
          `UPDATE appointments
              SET doctor_id = $2::int,
                  doctor_name = $3,
                  department = COALESCE($4, department),
                  appointment_date = $5::date,
                  appointment_time = $6,
                  status = 'SCHEDULED',
                  token_number = NULL,
                  confirmed_at = NULL,
                  visit_no = NULL,
                  notes = CASE
                            WHEN $7::text IS NOT NULL
                            THEN COALESCE(notes || ' | ', '') || $7::text
                            ELSE notes
                          END,
                  updated_by = COALESCE($8::uuid, updated_by),
                  updated_at = NOW()
            WHERE id = $1::int
              AND tenant_id = $9::uuid
            RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
                      appointment_date, appointment_time, status, reason, notes,
                      token_number, visit_no, confirmed_at, department, visit_type,
                      tenant_id, created_at, updated_at`,
          apptId,
          targetDoctorId ? parseInt(targetDoctorId, 10) : null,
          targetDoctorName,
          targetDepartment,
          appointment_date,
          appointment_time,
          notes || null,
          actorUid,
          targetTenantId,
        );

        await tx.$executeRawUnsafe(
          `INSERT INTO appointment_status_history
             (appointment_id, from_status, to_status, changed_by, changed_by_role, reason)
           VALUES ($1::int, $2, 'SCHEDULED', $3::int, $4, $5)`,
          apptId,
          prevStatus,
          actorId ? parseInt(actorId, 10) : null,
          actorRole || null,
          auditReason,
        );

        const queue = await ensureAppointmentQueueForAppointment(tx, rows[0], {
          actorUid,
          source: 'reschedule_patch',
        });

        updatedPatientUid = current.patient_uid ?? null;
        updatedDoctorUid = resolvedDoctor?.uid ?? current.doctor_uid ?? null;
        updatedDoctorId = targetDoctorId ? parseInt(targetDoctorId, 10) : null;

        return {
          previous: current,
          appointment: {
            ...rows[0],
            queue_id: queue?.id ?? rows[0]?.queue_id ?? null,
            appointment_queue: queue ?? null,
          },
          from_status: prevStatus,
          to_status: 'SCHEDULED',
        };
      });

      if (updatedPatientUid && (updatedDoctorUid || updatedDoctorId)) {
        await populateAppointmentCareTeam({
          appointment: updated.appointment,
          appointmentId: updated.appointment?.id ?? null,
          tenantId: targetTenantId,
          patientUid: updatedPatientUid,
          doctorUid: updatedDoctorUid,
          doctorId: updatedDoctorId,
          doctorRole: 'DOCTOR',
          createdBy: actorUid,
        });
      }

      return updated;
    } catch (error) {
      if (error?.statusCode && error.statusCode < 500) {
        logger.warn('Appointment reschedule rejected:', {
          statusCode: error.statusCode,
          message: error.message,
          conflictingId: error.conflictingId,
        });
      } else {
        logger.error('Error rescheduling appointment in place:', error);
      }
      throw error;
    }
  }

  async updateAppointmentStatus(id, status, notes = null, _updatedBy = null, tenantId = null) {
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
        await setTenantTx(requireTenantId(tenantId), async (tx) => {
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
          // (tenant_id, visit_number). Tenant is threaded from the caller
          // (req.tenantId); fall back to the platform default tenant (the
          // same default registerWalkIn uses) when unset.
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
              await tx.$executeRawUnsafe(
                `INSERT INTO emergency_visits
                   (tenant_id, visit_number, patient_uid, arrival_mode,
                    chief_complaint, status)
                 VALUES ($1::uuid, $2, $3::uuid, 'walk_in', $4, 'arriving')
                 ON CONFLICT (tenant_id, visit_number) DO NOTHING`,
                requireTenantId(tenantId), visitNo, patientUid,
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
                a.tenant_id,
                a.created_at, a.updated_at, a.visit_type
           FROM appointments a
           LEFT JOIN users p ON p.id = a.patient_id
           LEFT JOIN users d ON d.id = a.doctor_id
          WHERE a.id = $1
          LIMIT 1`,
        apptId,
      );
      const appointment = rows[0];
      if (appointment && !['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(String(appointment.status || '').toUpperCase())) {
        const queue = await ensureAppointmentQueueForAppointment(prisma, appointment, {
          source: 'status_update',
        });
        return {
          ...appointment,
          queue_id: queue?.id ?? null,
          appointment_queue: queue,
        };
      }
      return appointment;
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
        `Cancelled by ${cancelledBy}`, null, null
      );
    } catch (error) {
      logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }
}

export default new AppointmentService();
