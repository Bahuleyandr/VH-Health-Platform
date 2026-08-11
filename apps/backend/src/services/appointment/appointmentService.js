// src/services/appointment/appointmentService.js
// Migrated from raw pg to Prisma ORM

import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import prisma, { setTenantTx } from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { requireTenantId } from '../tenant/tenantService.js';
import { composeVisitNo, deptPrefix } from '../../controllers/appointment/appointmentWorkflowController.js';
import { resolveDoctorRef } from '../doctor/doctorRefService.js';
import { ensureAppointmentQueueForAppointment } from './appointmentQueueService.js';
import { populateAppointmentCareTeam } from '../security/careTeamPopulationService.js';
import {
  recordAppointmentCreatedEvidenceTx,
  transitionAppointment,
} from './appointmentLifecycleService.js';
import { lockAppointmentPatientIdentity } from './appointmentPatientIdentityService.js';

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

  async createAppointment(appointmentData, options = {}) {
    const {
      patient_id,
      patient_phone = null,
      doctor_id,
      appointment_date,
      appointment_time,
      reason,
      notes = null,
      department = null,
      visit_type = null,
      admin_override = false,
      override_reason = null,
      tenant_id = null,
    } = appointmentData;
    const {
      actorUid = null,
      actorId = null,
      actorRole = null,
      ignoreConflicts = false,
      source = 'book',
      requirePatientPhoneMatch = false,
    } = options;
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
        const [patient, resolvedDoctor] = await Promise.all([
          lockAppointmentPatientIdentity(tx, {
            tenantId: tenant_id,
            patientId: patient_id,
            expectedPhone: patient_phone,
            requirePhoneMatch: requirePatientPhoneMatch,
          }),
          hasDoctorId
            ? resolveDoctorRef(tx, doctor_id, { tenantId: tenant_id })
            : Promise.resolve(null),
        ]);
        const patientPhone = patient.phone ?? '';
        const patientName = patient.name ?? null;
        bookedPatientUid = patient.uid ?? null;
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
        const conflict = resolvedDoctorId && !ignoreConflicts
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
            admin_override, override_reason, tenant_id, created_at, updated_at
          ) VALUES (
            ${patientPhone}, ${Number(patient.id)}, ${patientName},
            ${resolvedDoctorId ? parseInt(resolvedDoctorId, 10) : null}, ${doctorName},
            ${appointment_date}::date, ${appointment_time},
            ${reason ?? null}, ${notes ?? null},
            ${APPOINTMENT_CONFIG.STATUSES.SCHEDULED}, ${resolvedDepartment}, ${resolvedVisitType},
            ${actorUid || null}::uuid,
            ${admin_override === true}, ${override_reason ?? null},
            COALESCE(${tenant_id}::uuid, '00000000-0000-4000-8000-000000000001'::uuid),
            NOW(), NOW()
          )
          RETURNING id, uid, phone, patient_id, patient_name, doctor_id, doctor_name,
            appointment_date, appointment_time, status, reason, notes, department, visit_type,
            admin_override, override_reason, tenant_id, created_at, updated_at
        `;

        const appointment = rows[0];
        const queue = await ensureAppointmentQueueForAppointment(tx, appointment, {
          actorUid,
          source: 'book',
        });
        const appointmentWithPatient = {
          ...appointment,
          patient_uid: bookedPatientUid,
          doctor_uid: bookedDoctorUid,
        };
        await recordAppointmentCreatedEvidenceTx(tx, {
          tenantId: requireTenantId(tenant_id),
          appointment: appointmentWithPatient,
          actorUid,
          actorId,
          actorRole,
          source,
        });

        return {
          ...appointmentWithPatient,
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
          createdBy: actorUid,
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
      const auditReason = notes
        ? `Rescheduled to ${appointment_date} ${appointment_time}: ${notes}`
        : `Rescheduled to ${appointment_date} ${appointment_time}`;
      const updated = await transitionAppointment({
        tenantId: targetTenantId,
        appointmentId: apptId,
        toStatus: 'SCHEDULED',
        actorUid,
        actorId,
        actorRole,
        reason: auditReason,
        source: 'reschedule_patch',
        eventType: 'appointment.rescheduled',
        allowSameStatus: true,
        mutate: async ({ tx, current }) => {
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
        const doctorChanging = Number(targetDoctorId || 0) !== Number(current.doctor_id || 0);

        if (doctorChanging) {
          const livePathways = await tx.$queryRawUnsafe(
            `SELECT id, owning_clinician_uid
               FROM care_pathway_instances
              WHERE tenant_id = $1::uuid
                AND patient_uid = $2::uuid
                AND pathway_key = 'op_contact_to_recovery'
                AND source_episode_type = 'appointment'
                AND source_episode_id = $3::integer::text
                AND clinical_status IN ('planned', 'active', 'on_hold')
              ORDER BY created_at DESC, id DESC
              LIMIT 2
              FOR UPDATE`,
            targetTenantId,
            current.patient_uid,
            apptId,
          );
          if (livePathways.length > 0) {
            throw AppError.conflict(
              'Changing the doctor requires an explicit accepted OP ownership handoff',
              'APPOINTMENT_RESCHEDULE_OWNER_CHANGE_REQUIRES_HANDOFF',
            );
          }
        }

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

        const queue = await ensureAppointmentQueueForAppointment(tx, rows[0], {
          actorUid,
          source: 'reschedule_patch',
        });

        updatedPatientUid = current.patient_uid ?? null;
        updatedDoctorUid = resolvedDoctor?.uid ?? current.doctor_uid ?? null;
        updatedDoctorId = targetDoctorId ? parseInt(targetDoctorId, 10) : null;

        return {
          appointment: {
            ...current,
            ...rows[0],
            patient_uid: current.patient_uid,
            doctor_uid: updatedDoctorUid,
            queue_id: queue?.id ?? rows[0]?.queue_id ?? null,
            appointment_queue: queue ?? null,
          },
          eventPayload: {
            same_row_reschedule: true,
            prior_appointment_date: current.appointment_date,
            prior_appointment_time: current.appointment_time,
            appointment_date,
            appointment_time,
          },
        };
        },
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

  async updateAppointmentStatus(
    id,
    status,
    notes = null,
    _updatedBy = null,
    tenantId = null,
    options = {},
  ) {
    try {
      const apptId = parseInt(id, 10);
      const targetTenantId = requireTenantId(tenantId);
      const normalizedStatus = String(status || '').toUpperCase();
      const {
        actorUid = null,
        actorId = null,
        actorRole = null,
        source = 'status_update',
      } = options;
      const transition = await transitionAppointment({
        tenantId: targetTenantId,
        appointmentId: apptId,
        toStatus: normalizedStatus,
        actorUid,
        actorId,
        actorRole,
        notes,
        reason: notes,
        source,
        mutate: async ({ tx, current }) => {
          let resolvedDepartment = current.department;
          let tokenNumber = current.token_number;
          let visitNo = current.visit_no;
          if (normalizedStatus === 'CONFIRMED') {
            if (!resolvedDepartment && current.doctor_id) {
              const doctorRows = await tx.$queryRawUnsafe(
                `SELECT COALESCE(department.name, doctor.department) AS department
                   FROM doctors AS doctor
                   LEFT JOIN departments AS department
                     ON department.id = doctor.department_id
                    AND department.tenant_id = doctor.tenant_id
                  WHERE doctor.tenant_id = $1::uuid
                    AND (doctor.id = $2::integer OR doctor.user_id = $2::integer)
                  LIMIT 1`,
                targetTenantId,
                Number(current.doctor_id),
              );
              const candidate = doctorRows[0]?.department;
              if (candidate) {
                resolvedDepartment = String(candidate).trim().slice(0, 100);
              }
            }
            if (!tokenNumber) {
              const targetDate = current.appointment_date;
              const dateValue = targetDate instanceof Date
                ? targetDate
                : new Date(targetDate);
              const visitPrefix = `${deptPrefix(resolvedDepartment)}-${dateValue.getFullYear()}${String(dateValue.getMonth() + 1).padStart(2, '0')}${String(dateValue.getDate()).padStart(2, '0')}-`;
              const tokenRows = await tx.$queryRawUnsafe(
                `SELECT COALESCE(MAX(NULLIF(token_number, '')::integer), 0) + 1
                          AS next_token
                   FROM appointments
                  WHERE tenant_id = $1::uuid
                    AND DATE(appointment_date) = DATE($2::date)
                    AND confirmed_at IS NOT NULL
                    AND token_number ~ '^[0-9]+$'
                    AND visit_no LIKE $3::text || '%'`,
                targetTenantId,
                targetDate,
                visitPrefix,
              );
              tokenNumber = String(Number(tokenRows[0].next_token));
            }
            visitNo ||= composeVisitNo({
              department: resolvedDepartment,
              date: current.appointment_date,
              tokenNumber,
            });
          }

          const rows = await tx.$queryRawUnsafe(
            `UPDATE appointments
                SET status = $1::text,
                    notes = CASE
                      WHEN $2::text IS NOT NULL
                      THEN COALESCE(notes || ' | ', '') || $2::text
                      ELSE notes
                    END,
                    token_number = CASE
                      WHEN $1::text = 'CONFIRMED'
                      THEN COALESCE(token_number, $3::text)
                      ELSE token_number
                    END,
                    visit_no = CASE
                      WHEN $1::text = 'CONFIRMED'
                      THEN COALESCE(visit_no, $4::text)
                      ELSE visit_no
                    END,
                    confirmed_at = CASE
                      WHEN $1::text = 'CONFIRMED'
                      THEN COALESCE(confirmed_at, NOW())
                      ELSE confirmed_at
                    END,
                    department = COALESCE(department, $5::text),
                    sla_target_at = CASE
                      WHEN $1::text = 'CONFIRMED'
                      THEN COALESCE(sla_target_at, created_at + INTERVAL '30 minutes')
                      ELSE sla_target_at
                    END,
                    updated_by = COALESCE($6::uuid, updated_by),
                    updated_at = NOW()
              WHERE id = $7::integer
                AND tenant_id = $8::uuid
              RETURNING id, uid, phone, patient_id, patient_name, doctor_id,
                        doctor_name, appointment_date, appointment_time, status,
                        reason, notes, token_number, visit_no, confirmed_at,
                        department, visit_type, queue_id, tenant_id, created_at,
                        updated_at`,
            normalizedStatus,
            notes ?? null,
            tokenNumber,
            visitNo,
            resolvedDepartment || null,
            actorUid,
            apptId,
            targetTenantId,
          );
          let appointment = {
            ...current,
            ...rows[0],
            patient_uid: current.patient_uid,
            doctor_uid: current.doctor_uid,
          };
          if (
            normalizedStatus === 'CONFIRMED'
            && (
              deptPrefix(resolvedDepartment) === 'EMER'
              || String(current.visit_type || '').toUpperCase() === 'EMERGENCY'
            )
          ) {
            await tx.$executeRawUnsafe(
              `INSERT INTO emergency_visits
                 (tenant_id, visit_number, patient_uid, arrival_mode,
                  chief_complaint, status)
               VALUES ($1::uuid, $2::text, $3::uuid, 'walk_in', $4::text, 'arriving')
               ON CONFLICT (tenant_id, visit_number) DO NOTHING`,
              targetTenantId,
              appointment.visit_no,
              current.patient_uid,
              'Confirmed via /status fallback',
            );
          }
          if (!['CANCELLED', 'NO_SHOW', 'RESCHEDULED'].includes(normalizedStatus)) {
            const queue = await ensureAppointmentQueueForAppointment(tx, appointment, {
              actorUid,
              source,
            });
            appointment = {
              ...appointment,
              queue_id: queue?.id ?? appointment.queue_id ?? null,
              appointment_queue: queue ?? null,
            };
          }
          return { appointment };
        },
      });
      return transition.appointment;
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

  async cancelAppointment(id, cancelledBy, options = {}) {
    try {
      return await this.updateAppointmentStatus(
        id, APPOINTMENT_CONFIG.STATUSES.CANCELLED,
        `Cancelled by ${cancelledBy}`, null, options.tenantId, options
      );
    } catch (error) {
      logger.error('Error cancelling appointment:', error);
      throw error;
    }
  }
}

export default new AppointmentService();
