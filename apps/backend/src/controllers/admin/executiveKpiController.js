// src/controllers/admin/executiveKpiController.js
//
// C-suite KPI digest. Aggregates revenue, occupancy, patient satisfaction, and
// doctor utilisation over a configurable window (defaults to month-to-date).
// All queries go through the read replica where available.

import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { resolveTenantOrThrow } from '../../services/tenant/tenantService.js';
import { success, error } from '../../utils/responseHelper.js';

function tenantOf(req) {
  return resolveTenantOrThrow(req);
}

export async function getExecutiveKpi(req, res) {
  try {
    const windowDays = Math.max(1, Math.min(parseInt(req.query.days, 10) || 30, 365));
    const tenantId = tenantOf(req);

    const [revenueRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(SUM(total_amount), 0)::float AS revenue_total,
         COALESCE(SUM(paid_amount), 0)::float  AS revenue_collected,
         COUNT(*)::int                         AS invoice_count,
         COUNT(*) FILTER (WHERE payment_status = 'paid')::int    AS paid,
         COUNT(*) FILTER (WHERE payment_status = 'pending')::int AS pending
       FROM invoices
       WHERE tenant_id = $1::uuid
         AND issued_at >= NOW() - ($2 || ' days')::interval`,
      tenantId,
      String(windowDays),
    );

    const [bedRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(*)::int                                           AS total,
         COUNT(*) FILTER (WHERE UPPER(status) = 'OCCUPIED')::int AS occupied
       FROM beds
       WHERE tenant_id = $1::uuid`,
      tenantId,
    );
    const occupancyPct = bedRow?.total > 0
      ? Math.round((bedRow.occupied / bedRow.total) * 100)
      : 0;

    const [feedbackRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COALESCE(AVG(rating), 0)::float AS avg_rating,
         COUNT(*)::int                   AS responses
       FROM feedback
       WHERE created_at >= NOW() - ($1 || ' days')::interval
         AND (
           (uid IS NOT NULL AND EXISTS (
             SELECT 1 FROM users u
              WHERE u.uid = feedback.uid
                AND u.tenant_id = $2::uuid
           ))
           OR (appointment_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM appointments a
              WHERE a.id = feedback.appointment_id
                AND a.tenant_id = $2::uuid
           ))
         )`,
      String(windowDays),
      tenantId,
    );

    const [doctorRow] = await prisma.$queryRawUnsafe(
      `SELECT
         COUNT(DISTINCT doctor_id)::int                                          AS active_doctors,
         COUNT(*)::int                                                           AS appointments,
         COUNT(*) FILTER (WHERE status = 'COMPLETED')::int                       AS completed
       FROM appointments
       WHERE tenant_id = $1::uuid
         AND appointment_date >= CURRENT_DATE - ($2 || ' days')::interval`,
      tenantId,
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
