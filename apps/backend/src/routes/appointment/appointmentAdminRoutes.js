// src/routes/appointment/appointmentAdminRoutes.js
import express from 'express';
import { HTTP_STATUS } from '../../config/responseCodes.js';
import { wrapAutoRBAC } from '../../config/routeWrapper.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { normalizePhone } from '../../utils/phoneUtils.js';
import { success, error } from '../../utils/responseHelper.js';

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
            COUNT(CASE WHEN status = 'scheduled' THEN 1 END) as scheduled,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
            COUNT(CASE WHEN status = 'no_show' THEN 1 END) as no_shows,
            ROUND(COUNT(CASE WHEN status = 'completed' THEN 1 END)::numeric / 
                  NULLIF(COUNT(*), 0) * 100, 2) as completion_rate,
            ROUND(COUNT(CASE WHEN status = 'no_show' THEN 1 END)::numeric / 
                  NULLIF(COUNT(*), 0) * 100, 2) as no_show_rate,
            COUNT(DISTINCT patient_id) as unique_patients,
            COUNT(DISTINCT doctor_id) as active_doctors
          FROM appointments a
          LEFT JOIN doctors d ON a.doctor_id = d.id
          ${whereClause}
        `, ...params);

        // Appointment trends
        const trends = await prisma.$queryRawUnsafe(`
          SELECT 
            DATE(appointment_date) as date,
            COUNT(*) as total,
            COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
            COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled
          FROM appointments a
          LEFT JOIN doctors d ON a.doctor_id = d.id
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
            COUNT(CASE WHEN a.status = 'completed' THEN 1 END) as completed,
            ROUND(AVG(EXTRACT(EPOCH FROM (a.updated_at - a.appointment_date))/60)) as avg_wait_time_minutes
          FROM appointments a
          JOIN doctors d ON a.doctor_id = d.id
          JOIN departments dept ON d.department_id = dept.id
          ${whereClause}
          GROUP BY dept.name
          ORDER BY appointments DESC
        `, ...params);

        // Peak hours analysis
        const peakHours = await prisma.$queryRawUnsafe(`
          SELECT 
            EXTRACT(HOUR FROM appointment_date) as hour,
            COUNT(*) as appointments,
            ROUND(AVG(consultation_duration_minutes)) as avg_duration
          FROM appointments a
          LEFT JOIN doctors d ON a.doctor_id = d.id
          ${whereClause}
          GROUP BY EXTRACT(HOUR FROM appointment_date)
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
          whereConditions.push(`a.status != 'cancelled'`);
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
              WHEN a.appointment_date < NOW() AND a.status = 'scheduled' THEN 'overdue'
              ELSE a.status 
            END as effective_status
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          JOIN doctors doc ON a.doctor_id = doc.id
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
          JOIN doctors doc ON a.doctor_id = doc.id
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

        let whereClause = `WHERE a1.id != a2.id AND a1.status = 'scheduled' AND a2.status = 'scheduled'`;
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
            a1.appointment_date as appointment1_time,
            p1.name as patient1_name,
            a2.id as appointment2_id,
            a2.appointment_date as appointment2_time,
            p2.name as patient2_name,
            d.name as doctor_name,
            dept.name as department
          FROM appointments a1
          JOIN appointments a2 ON a1.doctor_id = a2.doctor_id
          JOIN users p1 ON a1.patient_id = p1.id
          JOIN users p2 ON a2.patient_id = p2.id
          JOIN doctors doc ON a1.doctor_id = doc.id
          JOIN users d ON doc.user_id = d.id
          JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
            AND a1.appointment_date < a2.appointment_date
            AND a1.appointment_date + INTERVAL '30 minutes' > a2.appointment_date
          ORDER BY a1.appointment_date
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
            COUNT(CASE WHEN a.status = 'no_show' THEN 1 END) as no_show_count,
            COUNT(*) as total_appointments,
            ROUND(COUNT(CASE WHEN a.status = 'no_show' THEN 1 END)::numeric / 
                  COUNT(*) * 100, 2) as no_show_percentage,
            MAX(a.appointment_date) as last_appointment
          FROM appointments a
          JOIN users p ON a.patient_id = p.id
          WHERE a.appointment_date > NOW() - INTERVAL '${interval}'
          GROUP BY p.id, p.name, p.phone, p.email
          HAVING COUNT(CASE WHEN a.status = 'no_show' THEN 1 END) >= $1
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
          LEFT JOIN doctors doc ON a.doctor_id = doc.id
          LEFT JOIN users d ON doc.user_id = d.id
          LEFT JOIN departments dept ON doc.department_id = dept.id
          ${whereClause}
          ORDER BY a.appointment_date DESC, a.appointment_time DESC NULLS LAST
        `);

        if (format === 'csv') {
          const csv = [
            'ID,Date,Time,Patient,Phone,Doctor,Department,Status,Duration(min),Reason',
            ...appointments.map(a => 
              `${a.id},"${new Date(a.appointment_date).toLocaleDateString()}","${a.appointment_time || ''}","${a.patient_name || ''}","${a.patient_phone || ''}","${a.doctor_name || ''}","${a.department || ''}","${a.status || ''}",${a.consultation_duration_minutes || ''},"${a.reason || ''}"`
            )
          ].join('\n');

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

        let whereClause = 'WHERE DATE(a.appointment_date) = $1';
        const params = [date];

        if (department_id) {
          params.push(department_id);
          whereClause += ` AND doc.department_id = $${params.length}`;
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
          LEFT JOIN appointments a ON doc.id = a.doctor_id ${whereClause}
          LEFT JOIN users p ON a.patient_id = p.id
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
          LEFT JOIN appointments a ON doc.id = a.doctor_id ${whereClause}
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

        const placeholders = appointment_ids.map((_, i) => `$${i + 3}`).join(',');
        
        const result = await prisma.$queryRawUnsafe(`
          UPDATE appointments 
          SET status = $1, 
              notes = COALESCE(notes || E'\n', '') || 'Admin update: ' || $2,
              updated_at = NOW(),
              updated_by = $3
          WHERE id IN (${placeholders})
          RETURNING id, patient_id, doctor_id, appointment_date, status
        `, status, reason || `Status changed to ${status}`, req.user?.uid, ...appointment_ids);

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
        error(res, 'Failed to bulk update appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Admin Override Booking
    ['/override-book', async (req, res) => {
      try {
        const {
          patient_id, doctor_id, appointment_date,
          reason, override_reason, ignore_conflicts = false
        } = req.body;

        // Check for conflicts unless explicitly ignored
        if (!ignore_conflicts) {
          const conflictCheck = await prisma.$queryRawUnsafe(`
            SELECT id FROM appointments 
            WHERE doctor_id = $1 
              AND appointment_date = $2 
              AND status = 'scheduled'
          `, doctor_id, appointment_date);

          if (conflictCheck.length > 0) {
            return error(res, 'Time slot conflict detected. Set ignore_conflicts=true to override', HTTP_STATUS.CONFLICT);
          }
        }

        // Create appointment with admin override
        const result = await prisma.$queryRawUnsafe(`
          INSERT INTO appointments (
            patient_id, doctor_id, appointment_date, reason,
            status, created_at, created_by, 
            notes, admin_override, override_reason
          ) VALUES ($1, $2, $3, $4, 'scheduled', NOW(), $5, $6, true, $7)
          RETURNING id, patient_id, doctor_id, appointment_date, reason, status, notes, admin_override, override_reason, created_at, created_by, updated_at
        `, 
          patient_id, doctor_id, appointment_date, reason,
          req.user?.uid,
          `Admin override booking by ${req.user?.name}`,
          override_reason
        );

        logger.info(`Admin ${req.user?.name} override booked appointment ${result[0].id}`);

        success(res, {
          appointment: result[0],
          override: true,
          bookedBy: req.user?.name
        }, 'Appointment booked with admin override');

      } catch (err) {
        logger.error('Override Booking Error:', err);
        error(res, 'Failed to override book appointment', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }],

    // Resolve Conflicts
    ['/resolve-conflict', async (req, res) => {
      try {
        const { conflict_appointments, resolution_action, new_time } = req.body;

        if (!conflict_appointments || conflict_appointments.length !== 2) {
          return error(res, 'Exactly 2 conflicting appointment IDs required', HTTP_STATUS.BAD_REQUEST);
        }

        let result;
        
        switch (resolution_action) {
          case 'cancel_first':
            result = await prisma.$queryRawUnsafe(
              'UPDATE appointments SET status = $1, notes = $2 WHERE id = $3 RETURNING id, uid, phone, patient_name, doctor_name, date, status, notes, created_at, updated_at',
              'cancelled', `Cancelled by admin due to conflict resolution`, conflict_appointments[0]
            );
            break;

          case 'cancel_second':
            result = await prisma.$queryRawUnsafe(
              'UPDATE appointments SET status = $1, notes = $2 WHERE id = $3 RETURNING id, uid, phone, patient_name, doctor_name, date, status, notes, created_at, updated_at',
              'cancelled', `Cancelled by admin due to conflict resolution`, conflict_appointments[1]
            );
            break;

          case 'reschedule_first':
            if (!new_time) {
              return error(res, 'new_time required for rescheduling', HTTP_STATUS.BAD_REQUEST);
            }
            result = await prisma.$queryRawUnsafe(
              'UPDATE appointments SET appointment_date = $1, notes = $2 WHERE id = $3 RETURNING id, uid, phone, patient_name, doctor_name, date, status, notes, created_at, updated_at',
              new_time, `Rescheduled by admin due to conflict`, conflict_appointments[0]
            );
            break;

          case 'reschedule_second':
            if (!new_time) {
              return error(res, 'new_time required for rescheduling', HTTP_STATUS.BAD_REQUEST);
            }
            result = await prisma.$queryRawUnsafe(
              'UPDATE appointments SET appointment_date = $1, notes = $2 WHERE id = $3 RETURNING id, uid, phone, patient_name, doctor_name, date, status, notes, created_at, updated_at',
              new_time, `Rescheduled by admin due to conflict`, conflict_appointments[1]
            );
            break;
            
          default:
            return error(res, 'Invalid resolution_action', HTTP_STATUS.BAD_REQUEST);
        }

        logger.info(`Admin ${req.user?.name} resolved conflict: ${resolution_action}`);

        success(res, {
          resolution: resolution_action,
          updatedAppointment: result[0],
          resolvedBy: req.user?.name
        }, 'Conflict resolved successfully');

      } catch (err) {
        logger.error('Conflict Resolution Error:', err);
        error(res, 'Failed to resolve conflict', HTTP_STATUS.INTERNAL_SERVER_ERROR);
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
          whereConditions.push(`a.status != 'cancelled'`);
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
          JOIN doctors doc ON a.doctor_id = doc.id
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
    // Bulk Delete (with audit trail)
    ['/bulk-delete', async (req, res) => {
      try {
        const { appointment_ids, reason } = req.body;

        if (!appointment_ids || !Array.isArray(appointment_ids) || appointment_ids.length === 0) {
          return error(res, 'appointment_ids array is required', HTTP_STATUS.BAD_REQUEST);
        }

        if (!reason) {
          return error(res, 'Deletion reason is required', HTTP_STATUS.BAD_REQUEST);
        }

        // Archive before deletion
        const archiveResult = await prisma.$queryRawUnsafe(`
          INSERT INTO appointment_archive (
            original_id, patient_id, doctor_id, appointment_date,
            status, reason, notes, deleted_by, deleted_at, deletion_reason
          )
          SELECT 
            id, patient_id, doctor_id, appointment_date,
            status, reason, notes, $1, NOW(), $2
          FROM appointments
          WHERE id = ANY($3)
          RETURNING original_id
        `, req.user?.uid, reason, appointment_ids);

        // Delete appointments
        const placeholders = appointment_ids.map((_, i) => `$${i + 1}`).join(',');
        await prisma.$queryRawUnsafe(
          `DELETE FROM appointments WHERE id IN (${placeholders})`,
          appointment_ids
        );

        logger.info(`Admin ${req.user?.name} bulk deleted ${archiveResult.length} appointments`);

        success(res, {
          deletedCount: archiveResult.length,
          deletedIds: archiveResult.map(r => r.original_id),
          reason,
          deletedBy: req.user?.name,
          archived: true
        }, `${archiveResult.length} appointments deleted and archived`);

      } catch (err) {
        logger.error('Bulk Delete Error:', err);
        error(res, 'Failed to bulk delete appointments', HTTP_STATUS.INTERNAL_SERVER_ERROR);
      }
    }]
  ]
});

export default router;
