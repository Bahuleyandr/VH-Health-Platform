// src/controllers/staff/staffAdminHRController.js
import { HTTP_STATUS } from '../../config/responseCodes.js';
import prisma from '../../lib/prisma.js';
import logger from '../../logging/logger.js';
import { success, error } from '../../utils/responseHelper.js';

// Get Pending Reviews
export const getPendingReviews = async (req, res) => {
  try {
    const pendingReviews = await prisma.$queryRawUnsafe(`
      SELECT 
        pr.id,
        pr.staff_id,
        s.name as staff_name,
        s.department,
        pr.review_period,
        pr.created_at,
        DATE_PART('day', NOW() - pr.created_at) as pending_days
      FROM performance_reviews pr
      JOIN staff s ON pr.staff_id = s.id
      WHERE pr.status = 'pending'
      ORDER BY pr.created_at ASC
    `);

    success(res, {
      pendingReviews: pendingReviews,
      total: pendingReviews.length
    }, 'Pending reviews retrieved successfully');
  } catch (err) {
    logger.error('Pending Reviews Error:', err);
    error(res, 'Failed to retrieve pending reviews', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Get Onboarding Status
export const getOnboardingStatus = async (req, res) => {
  try {
    const onboardingStatus = await prisma.$queryRawUnsafe(`
      SELECT 
        s.id,
        s.name,
        s.department,
        s.join_date,
        COUNT(ot.id) as total_tasks,
        COUNT(ot.id) FILTER (WHERE ot.completed = true) as completed_tasks,
        ROUND(100.0 * COUNT(ot.id) FILTER (WHERE ot.completed = true) / NULLIF(COUNT(ot.id), 0), 2) as completion_percentage
      FROM staff s
      LEFT JOIN onboarding_tasks ot ON s.id = ot.staff_id
      WHERE s.join_date >= CURRENT_DATE - INTERVAL '90 days'
      GROUP BY s.id, s.name, s.department, s.join_date
      ORDER BY s.join_date DESC
    `);

    success(res, {
      onboardingStatus: onboardingStatus
    }, 'Onboarding status retrieved successfully');
  } catch (err) {
    logger.error('Onboarding Status Error:', err);
    error(res, 'Failed to retrieve onboarding status', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};

// Approve Performance Review
export const approvePerformanceReview = async (req, res) => {
  try {
    const { reviewId } = req.params;
    const { comments, final_rating } = req.body;
    const approvedBy = req.user?.uid;

    const result = await prisma.$queryRawUnsafe(`
      UPDATE performance_reviews
      SET 
        status = 'approved',
        approved_by = $2,
        approved_at = NOW(),
        approver_comments = $3,
        final_rating = COALESCE($4, rating)
      WHERE id = $1
      RETURNING id, staff_id, review_period, status, rating, final_rating, approved_by, approved_at, approver_comments, created_at
    `, reviewId, approvedBy, comments, final_rating);

    if (result.length === 0) {
      return error(res, 'Performance review not found', HTTP_STATUS.NOT_FOUND);
    }

    success(res, result[0], 'Performance review approved successfully');
  } catch (err) {
    logger.error('Approve Review Error:', err);
    error(res, 'Failed to approve performance review', HTTP_STATUS.INTERNAL_SERVER_ERROR);
  }
};
