// src/controllers/admin/executiveKpiController.js
//
// C-suite KPI digest. Aggregates revenue, occupancy, patient satisfaction, and
// doctor utilisation over a configurable window (defaults to month-to-date).
// All queries go through the read replica where available.

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

export async function getExecutiveKpi(req, res) {
  try {
    const windowDays = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));

    const [revenueRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(SUM(total_amount), 0)::float AS revenue_total,
         COALESCE(SUM(paid_amount), 0)::float  AS revenue_collected,
         COUNT(*)::int                         AS invoice_count,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int    AS paid,
         COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS pending
       FROM invoices
       WHERE issued_at >= NOW() - ($1 || ' days')::interval`,
      String(windowDays),
    );

    const [bedRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                                           AS total,
         COUNT(*) FILTER (WHERE status = 'OCCUPIED')::int        AS occupied
       FROM beds`,
    );
    const occupancyPct = bedRow?.total > 0
      ? Math.round((bedRow.occupied / bedRow.total) * 100)
      : 0;

    const [feedbackRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(AVG(rating), 0)::float AS avg_rating,
         COUNT(*)::int                   AS responses
       FROM feedback
       WHERE created_at >= NOW() - ($1 || ' days')::interval`,
      String(windowDays),
    );

    const [doctorRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(DISTINCT doctor_id)::int                                          AS active_doctors,
         COUNT(*)::int                                                           AS appointments,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int                       AS completed
       FROM appointments
       WHERE appointment_date >= CURRENT_DATE - ($1 || ' days')::interval`,
      String(windowDays),
    );
    const utilisationPct = doctorRow?.appointments > 0
      ? Math.round((doctorRow.completed / doctorRow.appointments) * 100)
      : 0;

    return success(res, {
      windowDays,
      revenue: {
        total: revenueRow?.revenue_total ?? 0,
        collected: revenueRow?.revenue_collected ?? 0,
        invoiceCount: revenueRow?.invoice_count ?? 0,
        paid: revenueRow?.paid ?? 0,
        pending: revenueRow?.pending ?? 0,
      },
      occupancy: {
        total: bedRow?.total ?? 0,
        occupied: bedRow?.occupied ?? 0,
        pct: occupancyPct,
      },
      satisfaction: {
        avgRating: Math.round((feedbackRow?.avg_rating ?? 0) * 100) / 100,
        responses: feedbackRow?.responses ?? 0,
      },
      doctorUtilisation: {
        activeDoctors: doctorRow?.active_doctors ?? 0,
        appointments: doctorRow?.appointments ?? 0,
        completed: doctorRow?.completed ?? 0,
        completionPct: utilisationPct,
      },
    }, 'Executive KPI summary');
  } catch (err) {
    logger.error('Executive KPI error:', err);
    return error(res, 'Failed to load executive KPI', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
}
