// src/routes/appointment/appointmentAdminRoutes.js
import express from 'express';
import { APPOINTMENT_CONFIG } from '../../config/appointmentConfig.js';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import appointmentService from '../../services/appointment/appointmentService.js';
import { transitionAppointment } from '../../services/appointment/appointmentLifecycleService.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error, relayAppError } from '../../utils/responseHelper.js';
import { rowsToCsv } from '../../utils/csv.js';

const router = express.Router();

// Admin-only appointment management routes
wrapAutoRBAC(router, 'appointmentAdminRoutes', {
  get: [
    // Test route
    ['/test', (req, res) => {
      res.json({ 
        message: 'Appointment admin routes working!',
        timestamp: new Date().toISOString(),
        requestedBy: req.user?.name
      });
    }],

    // Appointment Analytics Dashboard
    ['/analytics', async (req, res) => {
      try {
        const { timeframe = '30d', department_id, doctor_id } = req.query;
        
        let interval;
        switch (timeframe) {
          case '7d': interval = '7 days'; break;
          case '30d': interval = '30 days'; break;
          case '90d': interval = '90 days'; break;
          case '1y': interval = '1 year'; break;
          default: interval = '30 days';
        }

        let whereClause = `WHERE a.created_at > NOW() - INTERVAL '${interval}'`;
        const params = [];
        
        if (department_id) {
          params.push(department_id);
          whereClause += ` AND d.department_id = $${params.length}`;
        }
        
        if (doctor_id) {
          params.push(doctor_id);
          whereClause += ` AND a.doctor_id = $${params.length}`;
        }

        // Overall statistics
        const overallStats = await prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(*) as total_appointments,
            COUNT(CASE WHEN status = 'SCHEDULED' THEN 1 END) as scheduled,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled,
            COUNT(CASE WHEN status = 'NO_SHOW' THEN 1 END) as no_shows,
            ROUND(COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END)::numeric /
                  NULLIF(COUNT(*), 0) * 100, 2) as completion_rate,
            ROUND(COUNT(CASE WHEN status = 'NO_SHOW' THEN 1 END)::numeric /
                  NULLIF(COUNT(*), 0) * 100, 2) as no_show_rate,
            COUNT(DISTINCT patient_id) as unique_patients,
            COUNT(DISTINCT doctor_id) as active_doctors
          FROM appointments a
          LEFT JOIN doctors d ON d.user_id = a.doctor_id
          ${whereClause}
        `, ...params);

        // Appointment trends
        const trends = await prisma.$queryRawUnsafe(`
          SELECT
            DATE(appointment_date) as date,
            COUNT(*) as total,
            COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) as completed,
            COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) as cancelled
          FROM appointments a
          LEFT JOIN doctors d ON d.user_id = a.doctor_id
          ${whereClause}
          GROUP BY DATE(appointment_date)
          ORDER BY date DESC
          LIMIT 30
        `, ...params);

        // Department-wise breakdown
        const departmentStats = await prisma.$queryRawUnsafe(`
          SELECT 
            dept.name as department,
            COUNT(a.id) as appointments,
            COUNT(CASE WHEN a.status = 'COMPLETED' THEN 1 END) as completed,
            ROUND(AVG(EXTRACT(EPOCH FROM (a.updated_at - a.appointment_date))/60)) as avg_wait_time_minutes
          FROM appointments a
          JOIN doctors d ON d.user_id = a.doctor_id
          JOIN departments dept ON d.department_id = dept.id
          ${whereClause}
          GROUP BY dept.name
          ORDER BY appointments DESC
        `, ...params);

        // Peak hours analysis
        // NOTE: the hour-of-day lives in `appointment_time` (VARCHAR, e.g. '10:40'),
        // NOT in `appointment_date` (a DATE — EXTRACT(HOUR ...) is undefined on it).
        // Guard the ::time cast with a regex so non-clock values ('Walk-in') fall
        // into a NULL-hour bucket instead of erroring. appointments has no
        // consultation-duration column, so avg_duration is surfaced as NULL —
        // mirroring the /export handler, which models the same absent metric as
        // `NULL::integer as consultation_duration_minutes`.
        const peakHours = await prisma.$queryRawUnsafe(`
          SELECT
            EXTRACT(HOUR FROM
              CASE WHEN a.appointment_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
                   THEN a.appointment_time::time END) as hour,
            COUNT(*) as appointments,
            NULL::integer as avg_duration
          FROM appointments a
          LEFT JOIN doctors d ON d.user_id = a.doctor_id
          ${whereClause}
          GROUP BY 1
          ORDER BY hour
        `, ...params);

        success(res, {
          timeframe,
          overall: overallStats[0],
          trends: trends,
          departmentBreakdown: departmentStats,
          peakHours: peakHours,
          generatedAt: new Date().toISOString(),
          requestedBy: req.user?.name
        }, 'Appointment analytics retrieved successfully');

      } catch (err) {
        logger.error('Appointment Analytics Error:', err);
        error(res, 'Failed to retrieve appointment analytics', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Advanced Search with Multiple Filters
    ['/search', async (req, res) => {
      try {
        const {
          patient_name, patient_phone, doctor_name, department,
          status, date_from, date_to, include_cancelled = false,
          page = 1, limit = 50, sort_by: rawSortBy = 'appointment_date', order: rawOrder = 'DESC'
        } = req.query;

        // Whitelist sort columns to prevent SQL injection
        const ALLOWED_SORT = ['appointment_date', 'created_at', 'status', 'patient_name', 'doctor_name'];
        const ALLOWED_ORDER = ['ASC', 'DESC'];
        const sort_by = ALLOWED_SORT.includes(rawSortBy) ? rawSortBy : 'appointment_date';
        const order = ALLOWED_ORDER.includes(String(rawOrder).toUpperCase()) ? String(rawOrder).toUpperCase() : 'DESC';

        const whereConditions = [];
        const params = [];
        const offset = (page - 1) * limit;

        if (patient_name) {
          params.push(`%${patient_name}%`);
          whereConditions.push(`p.name ILIKE $${params.length}`);
        }

        if (patient_phone) {
          params.push(normalizePhone(patient_phone));
          whereConditions.push(`p.phone = $${params.length}`);
        }

        if (doctor_name) {
          params.push(`%${doctor_name}%`);
          whereConditions.push(`d.name ILIKE $${params.length}`);
        }

        if (department) {
          params.push(department);
          whereConditions.push(`dept.id = $${params.length}`);
        }

        if (status) {
          params.push(status);
          whereConditions.push(`a.status = $${params.length}`);
        } else if (!include_cancelled) {
          whereConditions.push(`a.status != 'CANCELLED'`);
        }

        if (date_from) {
          params.push(date_from);
          whereConditions.push(`a.appointment_date >= $${params.length}::date`);
        }

        if (date_to) {
          params.push(date_to);
          whereConditions.push(`a.appointment_date <= $${params.length}::date`);
        }

        const whereClause = whereConditions.length > 0 
          ? 'WHERE ' + whereConditions.join(' AND ') 
          : '';

        // Get appointments with full details
        const appointments = await prisma.$queryRawUnsafe(`
          SELECT 
            a.*,
            p.name as patient_name,
            p.phone as patient_phone,
            p.email as patient_email,
            d.name as doctor_name,
            dept.name as department_name,
            CASE
              WHEN a.appointment_date < NOW() AND a.status = 'SCHEDULED' THEN 'overdue'
              ELSE a.status
            END as effective_status
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          JOIN doctors doc ON doc.user_id = a.doctor_id
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
          ORDER BY ${sort_by} ${order}
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `, ...params, limit, offset);

        // Get total count
        const countResult = await prisma.$queryRawUnsafe(`
          SELECT COUNT(*)
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          JOIN doctors doc ON doc.user_id = a.doctor_id
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
        `, ...params);

        const totalCount = parseInt(countResult[0].count);

        success(res, {
          appointments: appointments,
          pagination: {
            page: parseInt(page),
            limit: parseInt(limit),
            total: totalCount,
            totalPages: Math.ceil(totalCount / limit)
          },
          filters: {
            patient_name, patient_phone, doctor_name, department,
            status, date_from, date_to, include_cancelled
          },
          requestedBy: req.user?.name
        }, 'Appointment search completed');

      } catch (err) {
        logger.error('Appointment Search Error:', err);
        error(res, 'Failed to search appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Conflict Detection
    ['/conflicts', async (req, res) => {
      try {
        const { date, doctor_id } = req.query;

        let whereClause = `WHERE a1.id != a2.id AND a1.status = 'SCHEDULED' AND a2.status = 'SCHEDULED'`;
        const params = [];

        if (date) {
          params.push(date);
          whereClause += ` AND DATE(a1.appointment_date) = $${params.length}`;
        }

        if (doctor_id) {
          params.push(doctor_id);
          whereClause += ` AND a1.doctor_id = $${params.length}`;
        }

        const conflicts = await prisma.$queryRawUnsafe(`
          SELECT
            a1.id as appointment1_id,
            (a1.appointment_date + a1.appointment_time::time) as appointment1_time,
            p1.name as patient1_name,
            a2.id as appointment2_id,
            (a2.appointment_date + a2.appointment_time::time) as appointment2_time,
            p2.name as patient2_name,
            d.name as doctor_name,
            dept.name as department
          FROM appointments a1
          JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
          JOIN users p1 ON a1.patient_id = p1.id
          JOIN users p2 ON a2.patient_id = p2.id
          JOIN doctors doc ON doc.user_id = a1.doctor_id
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
            AND a1.appointment_date = a2.appointment_date
            AND a1.appointment_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
            AND a2.appointment_time ~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
            AND a1.appointment_time::time < a2.appointment_time::time
            AND a1.appointment_time::time + INTERVAL '30 minutes' > a2.appointment_time::time
          ORDER BY a1.appointment_date, a1.appointment_time
        `, ...params);

        success(res, {
          conflicts: conflicts,
          totalConflicts: conflicts.length,
          date,
          doctor_id,
          requestedBy: req.user?.name
        }, 'Appointment conflicts retrieved');

      } catch (err) {
        logger.error('Conflict Detection Error:', err);
        error(res, 'Failed to detect conflicts', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // No-Show Report
    ['/no-shows', async (req, res) => {
      try {
        const { timeframe = '30d', threshold = 2 } = req.query;

        let interval;
        switch (timeframe) {
          case '7d': interval = '7 days'; break;
          case '30d': interval = '30 days'; break;
          case '90d': interval = '90 days'; break;
          default: interval = '30 days';
        }

        const noShowPatients = await prisma.$queryRawUnsafe(`
          SELECT 
            p.id,
            p.name,
            p.phone,
            p.email,
            COUNT(CASE WHEN a.status = 'NO_SHOW' THEN 1 END) as no_show_count,
            COUNT(*) as total_appointments,
            ROUND(COUNT(CASE WHEN a.status = 'NO_SHOW' THEN 1 END)::numeric /
                  COUNT(*) * 100, 2) as no_show_percentage,
            MAX(a.appointment_date) as last_appointment
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          WHERE a.appointment_date > NOW() - INTERVAL '${interval}'
          GROUP BY p.id, p.name, p.phone, p.email
          HAVING COUNT(CASE WHEN a.status = 'NO_SHOW' THEN 1 END) >= $1
          ORDER BY no_show_count DESC
        `, threshold);

        success(res, {
          noShowPatients: noShowPatients,
          timeframe,
          threshold,
          totalPatientsWithNoShows: noShowPatients.length,
          requestedBy: req.user?.name
        }, 'No-show report generated');

      } catch (err) {
        logger.error('No-Show Report Error:', err);
        error(res, 'Failed to generate no-show report', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Export Appointments
    ['/export', async (req, res) => {
      try {
        const { format = 'json', date_from, date_to, department_id } = req.query;
        const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
        const dateFrom = date_from ? String(date_from).trim() : null;
        const dateTo = date_to ? String(date_to).trim() : null;
        const departmentId = department_id ? String(department_id).trim() : null;
        const whereConditions = [];

        if (dateFrom) {
          if (!isoDatePattern.test(dateFrom)) {
            return error(res, 'date_from must be in YYYY-MM-DD format', HTTP_STATUS.BAD_REQUEST);
          }
          whereConditions.push(`a.appointment_date >= DATE '${dateFrom}'`);
        }

        if (dateTo) {
          if (!isoDatePattern.test(dateTo)) {
            return error(res, 'date_to must be in YYYY-MM-DD format', HTTP_STATUS.BAD_REQUEST);
          }
          whereConditions.push(`a.appointment_date <= DATE '${dateTo}'`);
        }

        if (departmentId) {
          if (!/^\d+$/.test(departmentId)) {
            return error(res, 'department_id must be a numeric ID', HTTP_STATUS.BAD_REQUEST);
          }
          whereConditions.push(`doc.department_id = ${departmentId}`);
        }

        const whereClause = whereConditions.length > 0 
          ? 'WHERE ' + whereConditions.join(' AND ') 
          : '';

        const appointments = await prisma.$queryRawUnsafe(`
          SELECT 
            a.id,
            a.appointment_date,
            a.appointment_time,
            a.status,
            a.reason,
            COALESCE(a.patient_name, p.name) as patient_name,
            COALESCE(p.phone, a.phone) as patient_phone,
            COALESCE(a.doctor_name, d.name, doc.name) as doctor_name,
            COALESCE(a.department, dept.name, doc.department) as department,
            NULL::integer as consultation_duration_minutes,
            a.notes
          FROM appointments a
          LEFT JOIN users p ON a.patient_id = p.id
          LEFT JOIN doctors doc ON doc.user_id = a.doctor_id
          LEFT JOIN users d ON doc.user_id = d.id
          LEFT JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
          ORDER BY a.appointment_date DESC, a.appointment_time DESC NULLS LAST
        `);

        if (format === 'csv') {
          // Build via rowsToCsv so every field is formula-injection-neutralized
          // + RFC-4180-quoted. PHI text fields (patient/doctor/department/reason)
          // are attacker-influenceable and were previously interpolated verbatim
          // (audit §3 Admin — CSV/formula-injection).
          const headers = ['ID', 'Date', 'Time', 'Patient', 'Phone', 'Doctor', 'Department', 'Status', 'Duration(min)', 'Reason'];
          const rows = appointments.map((a) => [
            a.id,
            a.appointment_date ? new Date(a.appointment_date).toLocaleDateString() : '',
            a.appointment_time || '',
            a.patient_name || '',
            a.patient_phone || '',
            a.doctor_name || '',
            a.department || '',
            a.status || '',
            a.consultation_duration_minutes ?? '',
            a.reason || '',
          ]);
          const csv = rowsToCsv(headers, rows);

          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', 'attachment; filename=appointments.csv');
          return res.send(csv);
        }

        success(res, {
          appointments: appointments,
          count: appointments.length,
          exportDate: new Date().toISOString(),
          filters: { date_from: dateFrom, date_to: dateTo, department_id: departmentId },
          requestedBy: req.user?.name
        }, 'Appointments exported successfully');

      } catch (err) {
        logger.error('Export Error:', err);
        error(res, 'Failed to export appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Capacity Analysis
    ['/capacity', async (req, res) => {
      try {
        const { date = new Date().toISOString().split('T')[0], department_id } = req.query;

        // The date filter belongs in the appointments LEFT JOIN condition (not a
        // top-level WHERE) so doctors with zero bookings that day still appear —
        // capacity analysis must list every doctor. $1 (the date) is bound into
        // each query's `LEFT JOIN appointments a ON ... AND DATE(...) = $1`. The
        // optional department filter restricts which doctors appear, so it is a
        // trailing WHERE on the driving `doctors` table.
        const params = [date];
        let deptWhere = '';

        if (department_id) {
          params.push(department_id);
          deptWhere = `WHERE doc.department_id = $${params.length}`;
        }

        const capacity = await prisma.$queryRawUnsafe(`
          SELECT 
            d.id as doctor_id,
            d.name as doctor_name,
            dept.name as department,
            doc.max_appointments_per_day,
            COUNT(a.id) as booked_appointments,
            doc.max_appointments_per_day - COUNT(a.id) as available_slots,
            ROUND(COUNT(a.id)::numeric / doc.max_appointments_per_day * 100, 2) as utilization_percentage,
            array_agg(
              json_build_object(
                'time', a.appointment_date,
                'patient', p.name,
                'status', a.status
              ) ORDER BY a.appointment_date
            ) as appointments
          FROM doctors doc
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          LEFT JOIN appointments a ON a.doctor_id = doc.user_id AND DATE(a.appointment_date) = $1
          LEFT JOIN users p ON a.patient_id = p.id
          ${deptWhere}
          GROUP BY d.id, d.name, dept.name, doc.max_appointments_per_day
          ORDER BY utilization_percentage DESC
        `, ...params);

        const summary = await prisma.$queryRawUnsafe(`
          SELECT 
            COUNT(DISTINCT doc.id) as total_doctors,
            SUM(doc.max_appointments_per_day) as total_capacity,
            COUNT(a.id) as total_booked,
            SUM(doc.max_appointments_per_day) - COUNT(a.id) as total_available,
            ROUND(COUNT(a.id)::numeric / NULLIF(SUM(doc.max_appointments_per_day), 0) * 100, 2) as overall_utilization
          FROM doctors doc
          LEFT JOIN appointments a ON a.doctor_id = doc.user_id AND DATE(a.appointment_date) = $1
          ${deptWhere}
        `, ...params);

        success(res, {
          date,
          summary: summary[0],
          doctorCapacity: capacity,
          department_id,
          requestedBy: req.user?.name
        }, 'Capacity analysis completed');

      } catch (err) {
        logger.error('Capacity Analysis Error:', err);
        error(res, 'Failed to analyze capacity', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }]
  ],

  post: [
    // Bulk Status Update
    ['/bulk-update-status', async (req, res) => {
      try {
        const { appointment_ids, status, reason } = req.body;

        if (!appointment_ids || !Array.isArray(appointment_ids) || appointment_ids.length === 0) {
          return error(res, 'appointment_ids array is required', HTTP_STATUS.BAD_REQUEST);
        }

        if (!['completed', 'cancelled', 'no_show'].includes(status)) {
          return error(res, 'Invalid status. Must be completed, cancelled, or no_show', HTTP_STATUS.BAD_REQUEST);
        }
        const ids = [...new Set(appointment_ids.map(value => Number.parseInt(value, 10)))];
        if (
          ids.length > 200
          || ids.some(id => !Number.isInteger(id) || id <= 0)
        ) {
          return error(
            res,
            'appointment_ids must contain 1-200 positive integer IDs',
            HTTP_STATUS.BAD_REQUEST,
          );
        }
        if (ids.length !== 1) {
          return error(
            res,
            'Multi-appointment status mutation is retired; update one appointment at a time through the canonical lifecycle',
            HTTP_STATUS.CONFLICT,
            { topLevel: { code: 'APPOINTMENT_MULTI_STATUS_UPDATE_RETIRED' } },
          );
        }
        if (status === 'completed') {
          return error(
            res,
            'Bulk appointment completion is unsupported; complete each visit through its clinician-owned pathway workflow',
            HTTP_STATUS.CONFLICT,
            { topLevel: { code: 'APPOINTMENT_BULK_COMPLETION_UNSUPPORTED' } },
          );
        }

        const tenantId = resolveTenantOrThrow(req);
        const canonicalStatus = status.toUpperCase();
        const auditReason = reason || `Status changed to ${status}`;
        const transition = await transitionAppointment({
          tenantId,
          appointmentId: ids[0],
          toStatus: canonicalStatus,
          actorUid: req.user?.uid || null,
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          reason: auditReason,
          notes: `Admin update: ${auditReason}`,
          source: 'admin_bulk_update',
        });
        const result = [transition.appointment];

        // Log admin action
        for (const appointment of result) {
          logger.info(`Admin ${req.user?.name} bulk updated appointment ${appointment.id} to ${status}`);
        }

        success(res, {
          updatedCount: result.length,
          updatedAppointments: result,
          status,
          reason,
          updatedBy: req.user?.name
        }, `${result.length} appointments updated successfully`);

      } catch (err) {
        logger.error('Bulk Update Error:', err);
        return relayAppError(res, err, 'Failed to bulk update appointments');
      }
    }],

    // Admin Override Booking
    ['/override-book', async (req, res) => {
      try {
        const {
          patient_id, doctor_id, appointment_date,
          reason, override_reason, ignore_conflicts = false, visit_type
        } = req.body;
        const normalizedVisitType = visit_type
          ? String(visit_type).trim().toUpperCase()
          : null;
        if (normalizedVisitType && !APPOINTMENT_CONFIG.VISIT_TYPES.includes(normalizedVisitType)) {
          return error(
            res,
            `Visit type must be one of: ${APPOINTMENT_CONFIG.VISIT_TYPES.join(', ')}`,
            HTTP_STATUS.BAD_REQUEST,
          );
        }

        const instant = new Date(appointment_date);
        if (Number.isNaN(instant.getTime())) {
          return error(
            res,
            'appointment_date must be a valid date and time',
            HTTP_STATUS.BAD_REQUEST,
          );
        }
        const datePart = String(appointment_date).slice(0, 10);
        const timeMatch = String(appointment_date).match(/T(\d{2}:\d{2})/);
        const timePart = timeMatch?.[1]
          || `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`;
        const appointment = await appointmentService.createAppointment({
          patient_id,
          doctor_id,
          appointment_date: datePart,
          appointment_time: timePart,
          reason,
          notes: `Admin override booking by ${req.user?.name}`,
          visit_type: normalizedVisitType,
          admin_override: true,
          override_reason,
          tenant_id: resolveTenantOrThrow(req),
        }, {
          actorUid: req.user?.uid || null,
          actorId: req.user?.id || null,
          actorRole: req.user?.role || null,
          ignoreConflicts: ignore_conflicts === true,
          source: 'admin_override_book',
        });

        logger.info(`Admin ${req.user?.name} override booked appointment ${appointment.id}`);

        success(res, {
          appointment,
          override: true,
          bookedBy: req.user?.name
        }, 'Appointment booked with admin override');

      } catch (err) {
        logger.error('Override Booking Error:', err);
        return relayAppError(res, err, 'Failed to override book appointment');
      }
    }],

    // Resolve Conflicts
    ['/resolve-conflict', async (req, res) => {
      try {
        const { conflict_appointments, resolution_action, new_time } = req.body;

        if (!conflict_appointments || conflict_appointments.length !== 2) {
          return error(res, 'Exactly 2 conflicting appointment IDs required', HTTP_STATUS.BAD_REQUEST);
        }

        const tenantId = resolveTenantOrThrow(req);
        let updatedAppointment;
        
        switch (resolution_action) {
          case 'cancel_first':
            updatedAppointment = (await transitionAppointment({
              tenantId,
              appointmentId: conflict_appointments[0],
              toStatus: 'CANCELLED',
              actorUid: req.user?.uid || null,
              actorId: req.user?.id || null,
              actorRole: req.user?.role || null,
              reason: 'Cancelled by admin due to conflict resolution',
              notes: 'Cancelled by admin due to conflict resolution',
              source: 'admin_conflict_resolution',
            })).appointment;
            break;

          case 'cancel_second':
            updatedAppointment = (await transitionAppointment({
              tenantId,
              appointmentId: conflict_appointments[1],
              toStatus: 'CANCELLED',
              actorUid: req.user?.uid || null,
              actorId: req.user?.id || null,
              actorRole: req.user?.role || null,
              reason: 'Cancelled by admin due to conflict resolution',
              notes: 'Cancelled by admin due to conflict resolution',
              source: 'admin_conflict_resolution',
            })).appointment;
            break;

          case 'reschedule_first':
            if (!new_time) {
              return error(res, 'new_time required for rescheduling', HTTP_STATUS.BAD_REQUEST);
            }
            {
              const instant = new Date(new_time);
              if (Number.isNaN(instant.getTime())) {
                return error(res, 'new_time must be a valid date and time', HTTP_STATUS.BAD_REQUEST);
              }
              updatedAppointment = (await appointmentService.rescheduleAppointmentInPlace(
                conflict_appointments[0],
                {
                  appointment_date: String(new_time).slice(0, 10),
                  appointment_time: String(new_time).match(/T(\d{2}:\d{2})/)?.[1]
                    || `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`,
                  notes: 'Rescheduled by admin due to conflict',
                },
                {
                  tenantId,
                  actorUid: req.user?.uid || null,
                  actorId: req.user?.id || null,
                  actorRole: req.user?.role || null,
                },
              )).appointment;
            }
            break;

          case 'reschedule_second':
            if (!new_time) {
              return error(res, 'new_time required for rescheduling', HTTP_STATUS.BAD_REQUEST);
            }
            {
              const instant = new Date(new_time);
              if (Number.isNaN(instant.getTime())) {
                return error(res, 'new_time must be a valid date and time', HTTP_STATUS.BAD_REQUEST);
              }
              updatedAppointment = (await appointmentService.rescheduleAppointmentInPlace(
                conflict_appointments[1],
                {
                  appointment_date: String(new_time).slice(0, 10),
                  appointment_time: String(new_time).match(/T(\d{2}:\d{2})/)?.[1]
                    || `${String(instant.getHours()).padStart(2, '0')}:${String(instant.getMinutes()).padStart(2, '0')}`,
                  notes: 'Rescheduled by admin due to conflict',
                },
                {
                  tenantId,
                  actorUid: req.user?.uid || null,
                  actorId: req.user?.id || null,
                  actorRole: req.user?.role || null,
                },
              )).appointment;
            }
            break;
            
          default:
            return error(res, 'Invalid resolution_action', HTTP_STATUS.BAD_REQUEST);
        }

        logger.info(`Admin ${req.user?.name} resolved conflict: ${resolution_action}`);

        success(res, {
          resolution: resolution_action,
          updatedAppointment,
          resolvedBy: req.user?.name
        }, 'Conflict resolved successfully');

      } catch (err) {
        logger.error('Conflict Resolution Error:', err);
        return relayAppError(res, err, 'Failed to resolve conflict');
      }
    }],

    // Send Reminders
    ['/send-reminders', async (req, res) => {
      try {
        const { hours_before = 24, include_departments = [], exclude_cancelled = true } = req.body;

        // Clamp user-supplied hours into a sane range and bind into the
        // INTERVAL as a parameter (`make_interval(hours => $N::int)`)
        // instead of string-interpolating it into the SQL.
        const parsedHours = Number.parseInt(hours_before, 10);
        const safeHoursBefore = Number.isFinite(parsedHours) && parsedHours >= 1
          ? Math.min(parsedHours, 168) // cap at 1 week
          : 24;

        const params = [safeHoursBefore];
        const whereConditions = [
          `a.appointment_date BETWEEN NOW() AND NOW() + make_interval(hours => $${params.length}::int)`,
          `a.reminder_sent = false`
        ];

        if (exclude_cancelled) {
          whereConditions.push(`a.status != 'CANCELLED'`);
        }

        if (include_departments.length > 0) {
          params.push(include_departments);
          whereConditions.push(`doc.department_id = ANY($${params.length})`);
        }

        const appointments = await prisma.$queryRawUnsafe(`
          SELECT 
            a.id,
            a.appointment_date,
            p.name as patient_name,
            p.phone as patient_phone,
            p.email as patient_email,
            d.name as doctor_name,
            dept.name as department
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          JOIN doctors doc ON doc.user_id = a.doctor_id
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          WHERE ${whereConditions.join(' AND ')}
        `, ...params);

        // In a real implementation, this would trigger SMS/email sending
        // For now, just mark as reminder sent
        const appointmentIds = appointments.map(a => a.id);
        
        if (appointmentIds.length > 0) {
          await prisma.$queryRawUnsafe(
            `UPDATE appointments SET reminder_sent = true WHERE id = ANY($1)`,
            appointmentIds
          );
        }

        logger.info(`Admin ${req.user?.name} sent ${appointmentIds.length} appointment reminders`);

        success(res, {
          remindersSent: appointments.length,
          appointments: appointments.map(a => ({
            id: a.id,
            patient: a.patient_name,
            doctor: a.doctor_name,
            time: a.appointment_date
          })),
          sentBy: req.user?.name
        }, `${appointments.length} reminders queued for sending`);

      } catch (err) {
        logger.error('Send Reminders Error:', err);
        error(res, 'Failed to send reminders', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }]
  ],

  delete: [
    ['/bulk-delete', (_req, res) => error(
      res,
      'Appointment hard deletion is retired; use the canonical cancellation and retention workflows',
      410,
      { topLevel: { code: 'APPOINTMENT_HARD_DELETE_RETIRED' } },
    )]
  ]
});

export default router;
