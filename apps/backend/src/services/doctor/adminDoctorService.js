// src/services/doctor/adminDoctorService.js
import { DOCTOR_CONFIG, DOCTOR_MESSAGES } from '../../config/doctorConfig.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { AppError } from '../../utils/AppError.js';
import { buildPagination, parseListQuery } from '../../utils/listQuery.js';
import { CARE_PATHWAY_KEYS, PATHWAY_MODES } from '../pathways/pathwayMode.js';
import { requireTenantId } from '../tenant/tenantService.js';

const OP_PATHWAY_KEY = CARE_PATHWAY_KEYS.OP;

function normalizeDoctorIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [values])
      .map(value => Number.parseInt(value, 10))
      .filter(value => Number.isInteger(value) && value > 0)
  )];
}

async function lockFutureScheduledAppointmentsTx(tx, doctorIds) {
  const normalizedIds = normalizeDoctorIds(doctorIds);
  if (normalizedIds.length === 0) return [];

  // Appointment booking does not take a doctor-profile row lock. The table
  // lock closes the insert race between this preflight and the legacy bulk
  // cancellation/reassignment statement.
  await tx.$executeRawUnsafe(
    'LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE'
  );
  return tx.$queryRawUnsafe(
    `SELECT appointment.id, appointment.tenant_id,
            appointment.appointment_date, appointment.appointment_time,
            CASE
              WHEN LOWER(BTRIM(COALESCE(
                tenant.settings -> 'care_pathways' ->> $2::text,
                ''
              ))) = 'active'
              THEN 'active'
              WHEN LOWER(BTRIM(COALESCE(
                tenant.settings -> 'care_pathways' ->> $2::text,
                ''
              ))) = 'shadow'
              THEN 'shadow'
              ELSE 'off'
            END AS pathway_mode,
            EXISTS (
              SELECT 1
                FROM users AS patient
                JOIN care_pathway_instances AS pathway
                  ON pathway.tenant_id = appointment.tenant_id
                 AND pathway.patient_uid = patient.uid
                 AND pathway.pathway_key = $2::text
                 AND pathway.source_episode_type = 'appointment'
                 AND pathway.source_episode_id = appointment.id::text
                 AND pathway.clinical_status IN ('planned', 'active', 'on_hold')
               WHERE patient.tenant_id = appointment.tenant_id
                 AND patient.id = appointment.patient_id
            ) AS has_live_op_pathway
       FROM appointments AS appointment
       JOIN tenants AS tenant
         ON tenant.id = appointment.tenant_id
      WHERE appointment.doctor_id = ANY($1::int[])
        AND appointment.status = 'SCHEDULED'
        AND appointment.appointment_date > CURRENT_DATE
      ORDER BY appointment.tenant_id, appointment.id
      FOR UPDATE OF appointment, tenant`,
    normalizedIds,
    OP_PATHWAY_KEY
  );
}

function requireGovernedAppointmentLifecycle(appointments, operation) {
  const activeAppointments = appointments.filter(
    appointment => appointment.pathway_mode === PATHWAY_MODES.ACTIVE
  );
  if (activeAppointments.length === 0) return;

  const livePathwayCount = activeAppointments.filter(
    appointment => appointment.has_live_op_pathway === true
  ).length;
  throw AppError.conflict(
    'Active-pathway appointments must be cancelled or reassigned through the canonical per-appointment lifecycle and accepted ownership handoff workflow',
    'DOCTOR_APPOINTMENT_PATHWAY_CONVERGENCE_REQUIRED',
    {
      operation,
      affected_appointment_count: activeAppointments.length,
      live_pathway_count: livePathwayCount,
      projection_pending_count: activeAppointments.length - livePathwayCount
    }
  );
}

export class AdminDoctorService {
  // Get doctor management overview
  async getDoctorOverview() {
    try {
      const [doctorStats, performanceMetrics, departmentDistribution] = await Promise.all([
        // Doctor statistics
        prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(*) as total_doctors,
            COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_doctors,
            COUNT(CASE WHEN d.is_available = false THEN 1 END) as unavailable_doctors,
            COUNT(CASE WHEN d.created_at >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_doctors_30d,
            NULL::numeric as avg_experience,
            NULL::numeric as avg_consultation_fee
          FROM doctors d
          WHERE d.is_active = true
        `),
        
        // Performance metrics (last 30 days)
        prisma.$queryRawUnsafe(`
          SELECT d.id, COALESCE(u.name, d.name) as name,
                 d.specialty as specialization, d.department,
                 COUNT(a.id) as total_appointments,
                 COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed_appointments,
                 COUNT(CASE WHEN a.status = 'CANCELLED' THEN 1 END) as cancelled_appointments,
                 0 as revenue,
                 0 as avg_rating
          FROM doctors d
          LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
          LEFT JOIN appointments a ON a.doctor_id = COALESCE(d.user_id, d.id)
            AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days'
          WHERE d.is_active = true
          GROUP BY d.id, u.name, d.name, d.specialty, d.department
          ORDER BY total_appointments DESC
          LIMIT 10
        `),
        
        // Department distribution
        prisma.$queryRawUnsafe(`
          SELECT d.department, d.specialty as specialization,
                 COUNT(*) as doctor_count,
                 COUNT(CASE WHEN d.is_available = true THEN 1 END) as available_count,
                 0 as avg_fee
          FROM doctors d
          WHERE d.is_active = true
          GROUP BY d.department, d.specialty
          ORDER BY d.department, doctor_count DESC
        `)
      ]);
      
      return {
        statistics: doctorStats[0],
        top_performers: performanceMetrics,
        department_distribution: departmentDistribution
      };
    } catch (error) {
      logger.error('Error fetching doctor overview:', error);
      throw error;
    }
  }

  // Get doctor management list with advanced filtering
  async getDoctorManagementList(filters = {}) {
    try {
      const allowedSortFields = {
        name: 'COALESCE(u.name, d.name)',
        department: 'd.department',
        specialization: 'd.specialty',
        status: 'd.is_available',
        registered_at: 'COALESCE(u.registered_at, d.created_at)',
        total_appointments: 'total_appointments',
        recent_appointments: 'recent_appointments',
      };
      const {
        department,
        specialization,
        status,
      } = filters;
      const { page, limit, offset, search, sortBy, sortOrder } = parseListQuery(filters, {
        defaultLimit: DOCTOR_CONFIG.PAGINATION.DEFAULT_LIMIT,
        maxLimit: DOCTOR_CONFIG.PAGINATION.MAX_LIMIT || 100,
        defaultSortBy: 'name',
        defaultSortOrder: 'ASC',
        allowedSortFields: Object.keys(allowedSortFields),
      });
      const countFilters = {
        department,
        specialization,
        status,
        search,
      };
      
      // Drive from doctors table so standalone doctors (no user_id) are included
      let query = `
        SELECT
          d.id,
          COALESCE(u.id, d.user_id) as user_id,
          COALESCE(u.name, d.name) as name,
          u.phone, u.email, u.gender,
          TO_CHAR(COALESCE(u.registered_at, d.created_at), 'DD-MM-YYYY') as registered_at,
          d.specialty as specialization,
          d.department,
          NULL::int as experience_years,
          NULL::numeric as consultation_fee,
          NULL as available_days, NULL as available_hours, d.is_available,
          NULL as bio, NULL as education, NULL as certifications,
          COUNT(a.id) as total_appointments,
          COUNT(CASE WHEN a.status = 'COMPLETED' AND a.appointment_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as recent_appointments
        FROM doctors d
        LEFT JOIN users u ON u.id = d.user_id AND u.role = 'DOCTOR'
        LEFT JOIN appointments a ON a.doctor_id = COALESCE(u.id, d.user_id)
        WHERE d.is_active = true
      `;
      const params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      
      if (specialization) {
        query += ` AND d.specialty ILIKE $${params.length + 1}`;
        params.push(`%${specialization}%`);
      }

      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      
      if (search) {
        query += ` AND (COALESCE(u.name, d.name) ILIKE $${params.length + 1} OR d.specialty ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      query += ` GROUP BY d.id, u.id, u.name, u.phone, u.email, u.gender, u.registered_at,
                 d.name, d.specialty, d.department, d.is_available, d.created_at
                 ORDER BY ${allowedSortFields[sortBy]} ${sortOrder}, COALESCE(u.name, d.name) ASC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
      params.push(limit, offset);
      
      const [doctors, total] = await Promise.all([
        prisma.$queryRawUnsafe(query, ...params),
        this.countManagementDoctors(countFilters)
      ]);
      
      return {
        doctors: doctors.map((doctor) => ({
          ...doctor,
          total_appointments: Number(doctor.total_appointments || 0),
          recent_appointments: Number(doctor.recent_appointments || 0),
        })),
        pagination: buildPagination(total, page, limit),
        filters: {
          ...countFilters,
          search: search || null,
          sortBy,
          sortOrder,
        }
      };
    } catch (error) {
      logger.error('Error fetching doctor management list:', error);
      throw error;
    }
  }

  // Count doctors for management list
  async countManagementDoctors(filters) {
    try {
      const { department, specialization, status, search } = filters;
      
      let query = 'SELECT COUNT(*) FROM doctors d LEFT JOIN users u ON u.id = d.user_id AND u.role = \'DOCTOR\' WHERE d.is_active = true';
      const params = [];
      
      if (department) {
        query += ' AND d.department = $' + (params.length + 1);
        params.push(department);
      }
      if (specialization) {
        query += ` AND d.specialty ILIKE $${params.length + 1}`;
        params.push(`%${specialization}%`);
      }
      if (status === 'available') {
        query += ' AND d.is_available = true';
      } else if (status === 'unavailable') {
        query += ' AND d.is_available = false';
      }
      if (search) {
        query += ` AND (COALESCE(u.name, d.name) ILIKE $${params.length + 1} OR d.specialty ILIKE $${params.length + 1} OR d.department ILIKE $${params.length + 1})`;
        params.push(`%${search}%`);
      }
      
      const result = await prisma.$queryRawUnsafe(query, ...params);
      return parseInt(result[0].count);
    } catch (error) {
      logger.error('Error counting management doctors:', error);
      throw error;
    }
  }

  // Create comprehensive doctor account
  async createDoctorAccount(doctorData) {
    try {
      const { name, department, specialization, phone, email } = doctorData;

      // Check if doctor with same name+department already exists
      const existing = await prisma.$queryRaw`
        SELECT id FROM doctors WHERE LOWER(name) = LOWER(${name}) AND LOWER(department) = LOWER(${department})
      `;
      if (existing.length > 0) {
        throw new Error('Doctor with this name already exists in this department');
      }

      const rows = await prisma.$queryRawUnsafe(`
        INSERT INTO doctors (name, department, specialty, intro, is_available, is_active, created_at, updated_at)
        VALUES ($1, $2, $3, $4, true, true, NOW(), NOW())
        RETURNING id, name, department, specialty, intro, image_url,
          NULL::numeric as consultation_fee,
          NULL::text[] as available_days,
          NULL::jsonb as available_hours,
          is_available, is_active, created_at
      `, name, department, specialization || null, doctorData.intro || null);

      logger.info(`Doctor created: ${name} (${department})`);

      return {
        user: { name, phone: phone || null, email: email || null },
        doctor_profile: rows[0]
      };
    } catch (error) {
      logger.error('Error creating doctor account:', error);
      throw error;
    }
  }

  // Bulk doctor operations
async performBulkOperation(operation, doctorIds, data = {}, tenantId) {
  try {
    const validOperations = ['activate', 'deactivate', 'update_fee', 'change_department', 'update_schedule'];
    if (!validOperations.includes(operation)) {
      throw new Error('Invalid operation');
    }

    // Scope every mutation to the acting admin's tenant — doctor ids are
    // enumerable SERIALs, so without this a tenant-A admin could flip a
    // tenant-B doctor (and cancel their appointments) by id. Fails closed on a
    // missing tenant context (862b78de pattern; W1 no-default-fallback rule).
    const scopedTenant = requireTenantId(tenantId);

    let results = [];

    switch (operation) {
      case 'activate': {
        const activateResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET is_available = true, updated_at = NOW() WHERE user_id = ANY($1) AND tenant_id = $2::uuid RETURNING user_id',
          doctorIds, scopedTenant
        );
        results = activateResult;
        break;
      }

      case 'deactivate': {
        results = await prisma.$transaction(async tx => {
          const affectedAppointments = await lockFutureScheduledAppointmentsTx(
            tx,
            doctorIds
          );
          requireGovernedAppointmentLifecycle(
            affectedAppointments,
            'bulk_deactivate'
          );
          const deactivateResult = await tx.$queryRawUnsafe(
            'UPDATE doctors SET is_available = false, updated_at = NOW() WHERE user_id = ANY($1) AND tenant_id = $2::uuid RETURNING user_id',
            doctorIds, scopedTenant
          );

          // Preserve the legacy off/shadow behavior. Active-mode appointments
          // have already failed closed above and must use the governed flow.
          await tx.$queryRawUnsafe(`
            UPDATE appointments SET
              status = 'CANCELLED',
              notes = COALESCE(notes || ' ', '') || 'Doctor deactivated by admin',
              updated_at = NOW()
            WHERE doctor_id = ANY($1) AND tenant_id = $2::uuid AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
          `, doctorIds, scopedTenant);

          return deactivateResult;
        });
        break;
      }

      case 'update_fee': {
        if (!data.consultation_fee) {
          throw new Error('consultation_fee is required for update_fee operation');
        }
        const feeResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET consultation_fee = $1, updated_at = NOW() WHERE user_id = ANY($2) AND tenant_id = $3::uuid RETURNING user_id, consultation_fee',
          data.consultation_fee, doctorIds, scopedTenant
        );
        results = feeResult;
        break;
      }

      case 'change_department': {
        if (!data.department) {
          throw new Error('department is required for change_department operation');
        }
        const deptResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET department = $1, updated_at = NOW() WHERE user_id = ANY($2) AND tenant_id = $3::uuid RETURNING user_id, department',
          data.department, doctorIds, scopedTenant
        );
        results = deptResult;
        break;
      }

      case 'update_schedule': {
        if (!data.available_days || !data.available_hours) {
          throw new Error('available_days and available_hours are required for update_schedule operation');
        }
        const scheduleResult = await prisma.$queryRawUnsafe(
          'UPDATE doctors SET available_days = $1, available_hours = $2, updated_at = NOW() WHERE user_id = ANY($3) AND tenant_id = $4::uuid RETURNING user_id, available_days, available_hours',
          data.available_days, data.available_hours, doctorIds, scopedTenant
        );
        results = scheduleResult;
        break;
      }
    }
    
    return {
      operation,
      affected_doctors: results,
      count: results.length
    };
  } catch (error) {
    logger.error('Error performing bulk operation:', error);
    throw error;
  }
}

  // Update doctor availability with appointment handling
  async updateDoctorAvailability(id, availabilityData, tenantId) {
    try {
      const doctorIdentifier = parseInt(id, 10);
      const { is_available, reason } = availabilityData;
      // Scope the by-id lookup/mutation to the acting admin's tenant so a
      // tenant-A admin cannot flip a tenant-B doctor by enumerable id. The
      // guard SELECT throws NOT_FOUND for a cross-tenant id, failing the whole
      // transaction closed before any appointment write.
      const scopedTenant = requireTenantId(tenantId);

      return prisma.$transaction(async tx => {
        const doctorRows = await tx.$queryRawUnsafe(
          `SELECT id, user_id, specialty AS specialization, department,
                  is_available, created_at, updated_at
             FROM doctors
            WHERE (id = $1 OR user_id = $1) AND tenant_id = $2::uuid
            ORDER BY CASE WHEN id = $1 THEN 0 ELSE 1 END, id
            FOR UPDATE`,
          doctorIdentifier, scopedTenant
        );

        if (doctorRows.length === 0) {
          throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
        }

        let affectedAppointments = [];
        if (!is_available) {
          const doctorIds = normalizeDoctorIds(
            doctorRows.flatMap(doctor => [doctor.id, doctor.user_id])
          );
          const scheduledAppointments = await lockFutureScheduledAppointmentsTx(
            tx,
            doctorIds
          );
          requireGovernedAppointmentLifecycle(
            scheduledAppointments,
            'availability_unavailable'
          );
        }

        const result = await tx.$queryRawUnsafe(`
          UPDATE doctors SET
            is_available = $1,
            updated_at = NOW()
          WHERE (id = $2 OR user_id = $2) AND tenant_id = $3::uuid
          RETURNING id, user_id, specialty as specialization, department, is_available, created_at, updated_at
        `, is_available, doctorIdentifier, scopedTenant);

        // If making unavailable, preserve the legacy off/shadow cancellation.
        if (!is_available) {
          const doctorIds = normalizeDoctorIds(
            result.flatMap(doctor => [doctor.id, doctor.user_id])
          );
          const appointmentResult = await tx.$queryRawUnsafe(`
            UPDATE appointments SET
              status = 'CANCELLED',
              notes = COALESCE(notes || ' ', '') || 'Doctor became unavailable: ' || COALESCE($1, 'Administrative decision'),
              updated_at = NOW()
            WHERE doctor_id = ANY($2::int[]) AND tenant_id = $3::uuid AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
            RETURNING id, appointment_date, appointment_time
          `, reason || null, doctorIds, scopedTenant);

          affectedAppointments = appointmentResult;
        }

        return {
          doctor: result[0],
          affected_appointments: affectedAppointments.length,
          cancelled_appointments: affectedAppointments
        };
      });
    } catch (error) {
      logger.error('Error updating doctor availability:', error);
      throw error;
    }
  }

  // Delete doctor account with appointment handling
  async deleteDoctorAccount(id, options = {}, tenantId) {
    try {
      const doctorIdentifier = parseInt(id, 10);
      const { reason, transfer_patients_to } = options;
      // Scope the by-id lookup/mutation to the acting admin's tenant so a
      // tenant-A admin cannot delete a tenant-B doctor by enumerable id. The
      // guard SELECT throws NOT_FOUND for a cross-tenant id, failing closed.
      const scopedTenant = requireTenantId(tenantId);

      return prisma.$transaction(async tx => {
        // Verify and lock the exact doctor row before deriving affected
        // appointment tenants from the appointment rows themselves.
        const doctorCheck = await tx.$queryRawUnsafe(
          `SELECT d.id, d.user_id, d.tenant_id,
                  COALESCE(u.name, d.name) as name, d.department
             FROM doctors d
             LEFT JOIN users u ON u.id = d.user_id
            WHERE (d.id = $1 OR d.user_id = $1) AND d.tenant_id = $2::uuid
            ORDER BY CASE WHEN d.id = $1 THEN 0 ELSE 1 END, d.id
            FOR UPDATE OF d`,
          doctorIdentifier, scopedTenant
        );

        if (doctorCheck.length === 0) {
          throw new Error(DOCTOR_MESSAGES.NOT_FOUND);
        }

        const doctorIds = normalizeDoctorIds(
          doctorCheck.flatMap(doctor => [doctor.id, doctor.user_id])
        );
        const futureAppointments = await lockFutureScheduledAppointmentsTx(
          tx,
          doctorIds
        );
        const futureCount = futureAppointments.length;

        requireGovernedAppointmentLifecycle(
          futureAppointments,
          transfer_patients_to ? 'account_delete_transfer' : 'account_delete_cancel'
        );

        if (futureCount > 0 && !transfer_patients_to) {
          throw new Error(`Doctor has ${futureCount} future appointments. Provide transfer_patients_to doctor ID or cancel appointments first`);
        }

        // Transfer or cancel future appointments. Active-mode appointments
        // fail closed above; this remains the off/shadow compatibility path.
        if (futureCount > 0) {
          if (transfer_patients_to) {
            const transferTarget = parseInt(transfer_patients_to, 10);
            // Verify transfer target doctor exists
            const transferDoctor = await tx.$queryRawUnsafe(
              'SELECT name FROM users WHERE id = $1 AND role = $2 AND tenant_id = $3::uuid',
              transferTarget, 'DOCTOR', scopedTenant
            );

            if (transferDoctor.length === 0) {
              throw new Error('Transfer target doctor not found');
            }

            await tx.$executeRawUnsafe(`
              UPDATE appointments SET
                doctor_id = $1,
                notes = COALESCE(notes || ' ', '') || 'Transferred due to doctor account deletion',
                updated_at = NOW()
              WHERE doctor_id = ANY($2::int[]) AND tenant_id = $3::uuid AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
            `, transferTarget, doctorIds, scopedTenant);
          } else {
            await tx.$executeRawUnsafe(`
              UPDATE appointments SET
                status = 'CANCELLED',
                notes = COALESCE(notes || ' ', '') || 'Doctor account deleted: ' || COALESCE($1, 'Administrative decision'),
                updated_at = NOW()
              WHERE doctor_id = ANY($2::int[]) AND tenant_id = $3::uuid AND status = 'SCHEDULED' AND appointment_date > CURRENT_DATE
            `, reason || null, doctorIds, scopedTenant);
          }
        }

        // Soft delete: deactivate doctor
        await tx.$executeRawUnsafe(
          'UPDATE doctors SET is_available = false, is_active = false, updated_at = NOW() WHERE (id = $1 OR user_id = $1) AND tenant_id = $2::uuid',
          doctorIdentifier, scopedTenant
        );

        return {
          doctor: doctorCheck[0],
          appointments_handled: {
            future_appointments: futureCount,
            action: transfer_patients_to ? 'transferred' : 'cancelled',
            transfer_to: transfer_patients_to || null
          },
          deletion_reason: reason
        };
      });
    } catch (error) {
      logger.error('Error deleting doctor account:', error);
      throw error;
    }
  }
}

export const adminDoctorService = new AdminDoctorService();
