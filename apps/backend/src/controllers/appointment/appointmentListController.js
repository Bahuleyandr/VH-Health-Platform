import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentQueryService from '../../services/appointment/appointmentQueryService.js';
import { resolveDoctorFilterId } from '../../services/doctor/doctorRefService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { parseListQuery } from '../../utils/listQuery.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';

export const listAppointments = async (req, res) => {
  try {
    // Check permissions
    if (!APPOINTMENT_CONFIG.PERMISSIONS.VIEW_ALL.includes(req.user?.role)) {
      return error(res, 'Insufficient permissions to view all appointments', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      status: req.query.status,
      // Roadmap A9: accept either users.id (canonical) or doctors.id and
      // filter by the canonical users.id appointment rows actually store.
      doctor_id: await resolveDoctorFilterId(prisma, req.query.doctor_id, {
        tenantId: req.tenantId || null,
      }),
      patient_id: req.query.patient_id,
      department: req.query.department,
      date: req.query.date,
      search: req.query.search,
      // Admission-counter worklist: ?advised_for_admission=true returns
      // only appointments with a non-null advised_for_admission_at.
      advised_for_admission: req.query.advised_for_admission,
    };

    const pagination = parseListQuery(req.query, {
      defaultPage: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.PAGE,
      defaultLimit: APPOINTMENT_CONFIG.DEFAULT_PAGINATION.LIMIT,
      maxLimit: 100,
      defaultSortBy: 'appointment_date',
      allowedSortFields: [
        'appointment_date',
        'appointment_time',
        'created_at',
        'status',
        'patient',
        'doctor',
        'phone',
        'department',
        'token'
      ]
    });

    const result = await appointmentQueryService.getAppointments(
      filters,
      pagination,
      req.user?.role,
      req.user?.id,
      resolveTenantOrThrow(req) // CAN-018: explicit tenant scope on the list
    );

    success(res, {
      ...result,
      requestedBy: req.user?.name
    }, 'Appointments retrieved successfully');
  } catch (err) {
    logger.error('Error listing appointments:', err);
    return relayAppError(res, err, 'Failed to retrieve appointments');
  }
};

export const getAppointmentById = async (req, res) => {
  try {
    const { id } = req.params;
    
    const appointment = await appointmentQueryService.getAppointmentById(
      id,
      resolveTenantOrThrow(req)
    );
    
    if (!appointment) {
      return error(res, 'Appointment not found', HTTP_STATUS.NOT_FOUND);
    }

    // Check access permissions
    if (req.user?.role === 'PATIENT' && appointment.patient_id !== req.user.id) {
      return error(res, 'Access denied', HTTP_STATUS.FORBIDDEN);
    }
    if (req.user?.role === 'DOCTOR' && appointment.doctor_id !== req.user.id) {
      return error(res, 'Access denied', HTTP_STATUS.FORBIDDEN);
    }

    success(res, {
      appointment,
      accessedBy: req.user?.name
    }, 'Appointment retrieved successfully');
  } catch (err) {
    logger.error('Error getting appointment:', err);
    error(res, 'Failed to retrieve appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getRecentCompletedAppointments = async (req, res) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    // CAN-018: scope the completed-appointment picker to the caller's tenant.
    const rows = await prisma.$queryRawUnsafe(`
      SELECT
        a.id,
        COALESCE(NULLIF(u.name, ''), NULLIF(a.patient_name, ''), a.phone, 'Unknown patient') AS patient_name,
        to_char(a.appointment_date, 'YYYY-MM-DD') AS appointment_date,
        a.appointment_time
      FROM appointments a
      LEFT JOIN users u ON u.id = a.patient_id
      WHERE LOWER(a.status) IN ('completed', 'done')
        AND a.tenant_id = $2::uuid
      ORDER BY a.appointment_date DESC, a.appointment_time DESC
      LIMIT $1::int
    `, limit, resolveTenantOrThrow(req));

    success(res, rows.map((row) => ({
      id: Number(row.id),
      patient_name: row.patient_name || 'Unknown patient',
      appointment_date: row.appointment_date,
      appointment_time: row.appointment_time,
    })), 'Completed appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting completed appointments:', err);
    error(res, 'Failed to retrieve completed appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getDoctorAppointments = async (req, res) => {
  try {
    // Roadmap A9: canonicalize BEFORE the ownership check so a doctor who
    // passes their doctors.id profile id (the id the admin UI displays) is
    // recognized as themselves instead of getting a confusing 403 — while a
    // doctor probing someone ELSE's id still gets denied against the
    // canonical users.id.
    const canonicalDoctorId = await resolveDoctorFilterId(prisma, req.params.doctor_id, {
      tenantId: req.tenantId || null,
    });
    if (!canonicalDoctorId) {
      return error(res, 'doctor_id must be a positive integer', HTTP_STATUS.BAD_REQUEST);
    }

    // Check permissions
    if (req.user?.role === 'DOCTOR' && String(req.user.id) !== String(canonicalDoctorId)) {
      return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
    }

    const filters = {
      status: req.query.status,
      date: req.query.date
    };

    const appointments = await appointmentQueryService.getDoctorAppointments(canonicalDoctorId, filters);

    success(res, {
      appointments,
      count: appointments.length,
      doctor_id: canonicalDoctorId,
      requested_doctor_id: req.params.doctor_id,
      filters,
      requestedBy: req.user?.name
    }, 'Doctor appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting doctor appointments:', err);
    error(res, 'Failed to retrieve doctor appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getPatientAppointments = async (req, res) => {
  try {
    const { patient_id } = req.params;

    // D72 — Dependent appointment list keeps guardian id in URL.
    // Pre-fix: a PATIENT could only request `/patient/<their-own-id>`.
    // The guardian app, on tap-into-dependent, then either:
    //   (a) kept the guardian's own id in the URL and got back the
    //       guardian's appointments (the dependent's were invisible),
    //   (b) sent the dependent's id and got a 403 forbidden.
    // Neither produced the dependent's chart.
    //
    // Allow a PATIENT to request another patient's appointments when
    // the target is a confirmed dependent (users.guardian_user_id =
    // requester's id). The dependent's user row must also be active
    // — a deactivated dependent stays masked. Guardian acting via
    // X-Acting-As-Uid is a separate path (handled by jwtMiddleware);
    // this fix covers the explicit-URL form the patient app uses for
    // the appointment list tab.
    // Finding 2026-05-22-..._3edd5127.
    if (req.user?.role === 'PATIENT' && req.user.id !== parseInt(patient_id, 10)) {
      const targetId = parseInt(patient_id, 10);
      let allowed = false;
      if (Number.isInteger(targetId) && targetId > 0) {
        try {
          const dep = await prisma.users.findUnique({
            where: { id: targetId },
            select: { id: true, guardian_user_id: true, is_active: true },
          });
          if (dep
              && dep.guardian_user_id != null
              && Number(dep.guardian_user_id) === Number(req.user.id)
              && dep.is_active !== false) {
            allowed = true;
          }
        } catch (lookupErr) {
          logger.warn(`getPatientAppointments: dependent lookup failed for guardian=${req.user.id}, target=${targetId}: ${lookupErr.message}`);
        }
      }
      if (!allowed) {
        return error(res, 'Can only view your own appointments', HTTP_STATUS.FORBIDDEN);
      }
    }

    const filters = {
      status: req.query.status
    };

    const appointments = await appointmentQueryService.getPatientAppointments(patient_id, filters);

    success(res, {
      appointments,
      count: appointments.length,
      patient_id,
      filter: filters.status ? { status: filters.status } : null,
      requestedBy: req.user?.name
    }, 'Patient appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting patient appointments:', err);
    error(res, 'Failed to retrieve patient appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const getTodayAppointments = async (req, res) => {
  try {
    // Check permissions
    if (!APPOINTMENT_CONFIG.PERMISSIONS.VIEW_TODAY.includes(req.user?.role)) {
      return error(res, 'Insufficient permissions to view today\'s appointments', HTTP_STATUS.FORBIDDEN);
    }

    const result = await appointmentQueryService.getTodayAppointments(
      req.user?.role,
      req.user?.id
    );

    success(res, {
      ...result,
      count: result.appointments.length,
      requestedBy: req.user?.name
    }, 'Today\'s appointments retrieved successfully');
  } catch (err) {
    logger.error('Error getting today appointments:', err);
    error(res, 'Failed to retrieve today\'s appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

export const testRoute = (req, res) => {
  success(res, {
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    user: req.user?.name || 'Unknown'
  }, 'Appointment routes working!');
};
