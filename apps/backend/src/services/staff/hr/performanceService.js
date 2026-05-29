// src/services/staff/hr/performanceService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : null;

// Translate the HR request's `timeframe` arg into a Prisma date
// filter on staff_performance_reviews.review_date. Returns null
// when no date filter should be applied.
function reviewDateFilter(timeframe, start_date, end_date) {
  if (timeframe === 'custom' && start_date && end_date) {
    return { gte: new Date(start_date), lte: new Date(end_date) };
  }
  if (timeframe === 'quarterly') {
    const d = new Date();
    d.setMonth(d.getMonth() - 3);
    return { gte: d };
  }
  if (timeframe === 'annual') {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return { gte: d };
  }
  return null;
}

/**
 * Generate comprehensive performance report for staff
 * @param {Object} queryParams - Query parameters including department, timeframe, etc.
 * @returns {Object} Performance report data
 */
export const generatePerformanceReport = async (queryParams) => {
  const { department, timeframe, start_date, end_date } = queryParams;

  const activeStaffWhere = { is_active: true };
  if (department) activeStaffWhere.department = department;

  // Load active staff + their users row via the relation declared
  // in migration 090. staff_performance_reviews.staff_id is int and
  // the caller populates it with users.id (the existing INSERT at
  // createPerformanceReview:154 passes the request-body staff_id
  // which is a user id). Resolve reviews per-user below.
  const staffRows = await prisma.staff.findMany({
    where: activeStaffWhere,
    select: {
      employee_id: true,
      position: true,
      department: true,
      performance_rating: true,
      user_id: true,
      users: { select: { id: true, name: true } },
    },
  });

  const userIds = staffRows.map((s) => s.users?.id).filter((x) => x != null);

  // Reviews scoped to the selected staff and date window.
  const reviewWhere = { staff_id: { in: userIds } };
  const dateFilter = reviewDateFilter(timeframe, start_date, end_date);
  if (dateFilter) reviewWhere.review_date = dateFilter;

  const reviewRows = userIds.length > 0
    ? await prisma.staff_performance_reviews.findMany({
      where: reviewWhere,
      select: {
        staff_id: true,
        rating: true,
        review_date: true,
        reviewer_comments: true,
      },
    })
    : [];

  // Per-user aggregate: total reviews, average rating, last review,
  // distinct comments joined.
  const reviewAgg = new Map();
  for (const r of reviewRows) {
    const agg = reviewAgg.get(r.staff_id) ?? {
      total_reviews: 0,
      sum_rating: 0,
      count_rating: 0,
      last_review_date: null,
      comments: new Set(),
    };
    agg.total_reviews += 1;
    if (r.rating != null) {
      agg.sum_rating += Number(r.rating);
      agg.count_rating += 1;
    }
    if (r.review_date && (!agg.last_review_date || r.review_date > agg.last_review_date)) {
      agg.last_review_date = r.review_date;
    }
    if (r.reviewer_comments) agg.comments.add(r.reviewer_comments);
    reviewAgg.set(r.staff_id, agg);
  }

  const staffPerformance = staffRows
    .map((s) => {
      const userId = s.users?.id;
      const agg = userId != null ? reviewAgg.get(userId) : null;
      return {
        id: userId,
        name: s.users?.name ?? null,
        employee_id: s.employee_id,
        position: s.position,
        department: s.department,
        current_rating: s.performance_rating
          ? Math.round(Number(s.performance_rating) * 10) / 10 : null,
        total_reviews: agg?.total_reviews ?? 0,
        average_rating: agg && agg.count_rating > 0
          ? Math.round((agg.sum_rating / agg.count_rating) * 10) / 10 : null,
        last_review_date: agg ? fmtDate(agg.last_review_date) : null,
        recent_comments: agg ? [...agg.comments].join('; ') : null,
      };
    })
    .sort((a, b) => (a.department ?? '').localeCompare(b.department ?? '')
      || ((b.average_rating ?? -Infinity) - (a.average_rating ?? -Infinity)));

  // Add performance_trend and compute insights.
  for (const row of staffPerformance) {
    if (row.current_rating != null && row.average_rating != null) {
      row.performance_trend = row.current_rating > row.average_rating
        ? 'improving'
        : row.current_rating < row.average_rating ? 'declining' : 'stable';
    } else {
      row.performance_trend = 'unknown';
    }
  }

  // Department summary (across all active staff + their reviews,
  // not just the filtered set — mirrors the pre-ORM query which
  // dropped the department-filter from this aggregate).
  const allActiveStaff = await prisma.staff.findMany({
    where: { is_active: true },
    select: {
      department: true,
      performance_rating: true,
      user_id: true,
      users: { select: { id: true } },
    },
  });
  const allUserIds = allActiveStaff.map((s) => s.users?.id).filter((x) => x != null);
  const deptReviews = allUserIds.length > 0
    ? await prisma.staff_performance_reviews.findMany({
      where: {
        staff_id: { in: allUserIds },
        ...(dateFilter ? { review_date: dateFilter } : {}),
      },
      select: { staff_id: true, rating: true },
    })
    : [];

  // Map reviewer rating sums per user.
  const reviewByUser = new Map();
  for (const r of deptReviews) {
    const entry = reviewByUser.get(r.staff_id) ?? { sum: 0, count: 0 };
    if (r.rating != null) {
      entry.sum += Number(r.rating);
      entry.count += 1;
    }
    reviewByUser.set(r.staff_id, entry);
  }

  const deptAgg = new Map();
  for (const s of allActiveStaff) {
    const dept = s.department ?? '(none)';
    const agg = deptAgg.get(dept) ?? {
      department: dept,
      staff_count: 0,
      sum_current: 0, count_current: 0,
      sum_review: 0, count_review: 0, total_reviews: 0,
    };
    agg.staff_count += 1;
    if (s.performance_rating != null) {
      agg.sum_current += Number(s.performance_rating);
      agg.count_current += 1;
    }
    const reviewEntry = s.users?.id != null ? reviewByUser.get(s.users.id) : null;
    if (reviewEntry && reviewEntry.count > 0) {
      agg.sum_review += reviewEntry.sum;
      agg.count_review += reviewEntry.count;
      agg.total_reviews += reviewEntry.count;
    }
    deptAgg.set(dept, agg);
  }

  const departmentSummary = [...deptAgg.values()]
    .sort((a, b) => {
      const aAvg = a.count_current > 0 ? a.sum_current / a.count_current : -Infinity;
      const bAvg = b.count_current > 0 ? b.sum_current / b.count_current : -Infinity;
      return bAvg - aAvg;
    })
    .map((agg) => ({
      department: agg.department,
      staff_count: agg.staff_count,
      avg_current_rating: agg.count_current > 0
        ? Math.round((agg.sum_current / agg.count_current) * 10) / 10 : null,
      avg_review_rating: agg.count_review > 0
        ? Math.round((agg.sum_review / agg.count_review) * 10) / 10 : null,
      total_reviews: agg.total_reviews,
    }));

  // Performance distribution — all active, rated staff.
  const ratedStaff = allActiveStaff.filter((s) => s.performance_rating != null);
  const distBuckets = {
    excellent: 0, good: 0, satisfactory: 0,
    needs_improvement: 0, unsatisfactory: 0,
  };
  for (const s of ratedStaff) {
    const r = Number(s.performance_rating);
    if (r >= 4.5) distBuckets.excellent += 1;
    else if (r >= 4.0) distBuckets.good += 1;
    else if (r >= 3.0) distBuckets.satisfactory += 1;
    else if (r >= 2.0) distBuckets.needs_improvement += 1;
    else distBuckets.unsatisfactory += 1;
  }
  const performanceDistribution = Object.entries(distBuckets)
    .filter(([, count]) => count > 0)
    .map(([performance_level, count]) => ({ performance_level, count }));

  return {
    reportDetails: {
      department: department || 'All Departments',
      timeframe,
      dateRange: timeframe === 'custom' ? { start_date, end_date } : null,
      generatedAt: new Date().toISOString(),
    },
    staffPerformance,
    departmentSummary,
    performanceDistribution,
    insights: {
      totalStaffEvaluated: staffPerformance.length,
      averageRating: staffPerformance.length > 0
        ? Math.round((staffPerformance.reduce((sum, s) => sum + (s.current_rating || 0), 0)
            / staffPerformance.length) * 10) / 10
        : 0,
      highPerformers: staffPerformance.filter((s) => s.current_rating >= 4.0).length,
      needsAttention: staffPerformance.filter(
        (s) => s.current_rating != null && s.current_rating < 3.0,
      ).length,
    },
  };
};

async function resolvePerformanceReviewStaff(staffId) {
  const identifier = String(staffId || '').trim();
  if (!identifier) return null;
  const rows = await prisma.$queryRawUnsafe(`
    SELECT
      u.id,
      u.uid,
      u.name,
      u.phone,
      s.employee_id
    FROM users u
    JOIN staff s ON s.user_id = u.uid
    WHERE
      u.id::text = $1
      OR u.uid::text = $1
      OR UPPER(s.employee_id) = UPPER($1)
    LIMIT 1
  `, identifier);
  return rows[0] || null;
}

/**
 * Create a new performance review for a staff member
 * @param {Object} reviewData - Review data including ratings and feedback
 * @returns {Object} Created review details
 */
export const createPerformanceReview = async (reviewData) => {
  const {
    staff_id, rating, review_period, reviewer_comments,
    goals_achieved, areas_for_improvement, future_goals,
    training_recommendations, reviewerId, reviewerName,
  } = reviewData;

  // HR screens accept the visible employee ID, while older callers passed
  // users.id. Resolve both shapes here so review creation matches the UI.
  const user = await resolvePerformanceReviewStaff(staff_id);
  if (!user) {
    throw new Error('STAFF_NOT_FOUND');
  }

  // Create performance review. goals / improvements / future_goals /
  // training_recommendations are TEXT columns that callers pass as
  // structured objects; JSON-stringify to preserve the previous shape.
  const review = await prisma.staff_performance_reviews.create({
    data: {
      staff_id: Number(user.id),
      reviewer_id: reviewerId,
      rating,
      review_period,
      reviewer_comments,
      goals_achieved: goals_achieved ? JSON.stringify(goals_achieved) : null,
      areas_for_improvement: areas_for_improvement ? JSON.stringify(areas_for_improvement) : null,
      future_goals: future_goals ? JSON.stringify(future_goals) : null,
      training_recommendations: training_recommendations ? JSON.stringify(training_recommendations) : null,
      review_date: new Date(),
    },
    select: {
      id: true, staff_id: true, reviewer_id: true, rating: true, review_period: true,
      reviewer_comments: true, goals_achieved: true, areas_for_improvement: true,
      future_goals: true, training_recommendations: true, review_date: true, created_at: true,
    },
  });

  // Update staff's current rating. The pre-ORM version used
  // `WHERE user_id = $staff_id` which passed an int into a uuid
  // column — would've errored. Resolve via the users.uid we just
  // loaded and filter staff by user_id properly.
  await prisma.staff.updateMany({
    where: { user_id: user.uid },
    data: {
      performance_rating: rating,
      last_review_date: new Date(),
    },
  });

  // Notify the reviewed staff member. Original INSERT omitted the
  // NOT NULL `phone` column — same bug as leaveService fixed in
  // batch 50. Use the user's phone now that we have it loaded.
  await prisma.notifications.create({
    data: {
      user_id: user.id,
      phone: user.phone,
      title: 'Performance Review Completed',
      body: `Your ${review_period} performance review has been completed. Rating: ${rating}/5.0`,
      type: 'performance_review',
      related_id: review.id,
      updated_at: new Date(),
    },
  });

  // Log review activity.
  await prisma.hr_activity_logs.create({
    data: {
      hr_staff_uid: reviewerId,
      action: 'PERFORMANCE_REVIEW_CREATED',
      staff_id: Number(user.id),
      description: `Performance review created for ${user.name} - Rating: ${rating}/5.0`,
    },
  });

  logger.info(`📝 Performance review created for ${user.name} (${staff_id}) by ${reviewerName} - Rating: ${rating}/5.0`);

  return {
    review: {
      ...review,
      review_date: fmtDate(review.review_date),
      created_at: review.created_at.toLocaleString('en-IN'),
    },
    staffInfo: {
      name: user.name,
      employee_id: user.employee_id,
    },
  };
};
