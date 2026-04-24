// src/services/staff/hr/performanceService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Generate comprehensive performance report for staff
 * @param {Object} queryParams - Query parameters including department, timeframe, etc.
 * @returns {Object} Performance report data
 */
export const generatePerformanceReport = async (queryParams) => {
  const { department, timeframe, start_date, end_date, userRole } = queryParams;

  let dateFilter = '';
  let dateParams = [];
  
  if (timeframe === 'custom' && start_date && end_date) {
    dateFilter = 'AND spr.review_date BETWEEN $2 AND $3';
    dateParams = [start_date, end_date];
  } else if (timeframe === 'quarterly') {
    dateFilter = 'AND spr.review_date >= CURRENT_DATE - INTERVAL \'3 months\'';
  } else if (timeframe === 'annual') {
    dateFilter = 'AND spr.review_date >= CURRENT_DATE - INTERVAL \'1 year\'';
  }

  let whereClause = 'WHERE s.is_active = true';
  let paramIndex = 1;

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    queryParams.push(department);
    paramIndex++;
  }

  // Add date parameters
  queryParams.push(...dateParams);

  // Performance summary by staff
  const performanceData = await prisma.$queryRawUnsafe(`
    SELECT 
      u.id, u.name, s.employee_id, s.position, s.department,
      s.performance_rating as current_rating,
      COUNT(spr.id) as total_reviews,
      AVG(spr.rating) as average_rating,
      MAX(spr.review_date) as last_review_date,
      STRING_AGG(DISTINCT spr.reviewer_comments, '; ') as recent_comments
    FROM users u
    JOIN staff s ON u.uid = s.user_id
    LEFT JOIN staff_performance_reviews spr ON s.user_id = spr.staff_id ${dateFilter}
    ${whereClause}
    GROUP BY u.id, u.name, s.employee_id, s.position, s.department, s.performance_rating
    ORDER BY s.department, average_rating DESC NULLS LAST
  `, queryParams);

  // Department performance averages
  const departmentPerformance = await prisma.$queryRawUnsafe(`
    SELECT 
      s.department,
      COUNT(DISTINCT s.user_id) as staff_count,
      AVG(s.performance_rating) as avg_current_rating,
      AVG(spr.rating) as avg_review_rating,
      COUNT(spr.id) as total_reviews
    FROM staff s
    LEFT JOIN staff_performance_reviews spr ON s.user_id = spr.staff_id ${dateFilter}
    WHERE s.is_active = true
    GROUP BY s.department
    ORDER BY avg_current_rating DESC NULLS LAST
  `, dateParams);

  // Performance distribution
  const performanceDistribution = await prisma.$queryRawUnsafe(`
    SELECT 
      CASE 
        WHEN performance_rating >= 4.5 THEN 'excellent'
        WHEN performance_rating >= 4.0 THEN 'good'
        WHEN performance_rating >= 3.0 THEN 'satisfactory'
        WHEN performance_rating >= 2.0 THEN 'needs_improvement'
        ELSE 'unsatisfactory'
      END as performance_level,
      COUNT(*) as count
    FROM staff
    WHERE is_active = true AND performance_rating IS NOT NULL
    GROUP BY 
      CASE 
        WHEN performance_rating >= 4.5 THEN 'excellent'
        WHEN performance_rating >= 4.0 THEN 'good'
        WHEN performance_rating >= 3.0 THEN 'satisfactory'
        WHEN performance_rating >= 2.0 THEN 'needs_improvement'
        ELSE 'unsatisfactory'
      END
    ORDER BY performance_level DESC
  `);

  return {
    reportDetails: {
      department: department || 'All Departments',
      timeframe,
      dateRange: timeframe === 'custom' ? { start_date, end_date } : null,
      generatedAt: new Date().toISOString()
    },
    staffPerformance: performanceData.map(staff => ({
      ...staff,
      current_rating: staff.current_rating ? Math.round(staff.current_rating * 10) / 10 : null,
      average_rating: staff.average_rating ? Math.round(staff.average_rating * 10) / 10 : null,
      last_review_date: staff.last_review_date ? new Date(staff.last_review_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : null,
      performance_trend: staff.current_rating && staff.average_rating ? 
        (staff.current_rating > staff.average_rating ? 'improving' : 
         staff.current_rating < staff.average_rating ? 'declining' : 'stable') : 'unknown'
    })),
    departmentSummary: departmentPerformance.map(dept => ({
      ...dept,
      avg_current_rating: dept.avg_current_rating ? Math.round(dept.avg_current_rating * 10) / 10 : null,
      avg_review_rating: dept.avg_review_rating ? Math.round(dept.avg_review_rating * 10) / 10 : null
    })),
    performanceDistribution: performanceDistribution,
    insights: {
      totalStaffEvaluated: performanceData.length,
      averageRating: performanceData.length > 0 ? 
        Math.round((performanceData.reduce((sum, s) => sum + (s.current_rating || 0), 0) / performanceData.length) * 10) / 10 : 0,
      highPerformers: performanceData.filter(s => s.current_rating >= 4.0).length,
      needsAttention: performanceData.filter(s => s.current_rating && s.current_rating < 3.0).length
    }
  };
};

/**
 * Create a new performance review for a staff member
 * @param {Object} reviewData - Review data including ratings and feedback
 * @returns {Object} Created review details
 */
export const createPerformanceReview = async (reviewData) => {
  const {
    staff_id, rating, review_period, reviewer_comments,
    goals_achieved, areas_for_improvement, future_goals,
    training_recommendations, reviewerId, reviewerName
  } = reviewData;

  // Verify staff member exists
  const staffCheck = await prisma.$queryRawUnsafe(
    'SELECT u.name, s.employee_id FROM users u JOIN staff s ON u.uid = s.user_id WHERE u.id = $1',
    staff_id
  );

  if (staffCheck.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffCheck[0];

  // Create performance review
  const reviewResult = await prisma.$queryRawUnsafe(`
    INSERT INTO staff_performance_reviews (
      staff_id, reviewer_id, rating, review_period, reviewer_comments,
      goals_achieved, areas_for_improvement, future_goals,
      training_recommendations, review_date, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, NOW())
    RETURNING id, staff_id, reviewer_id, rating, review_period, reviewer_comments, goals_achieved, areas_for_improvement, future_goals, training_recommendations, review_date, created_at
  `, 
    staff_id, reviewerId, rating, review_period, reviewer_comments,
    goals_achieved ? JSON.stringify(goals_achieved) : null,
    areas_for_improvement ? JSON.stringify(areas_for_improvement) : null,
    future_goals ? JSON.stringify(future_goals) : null,
    training_recommendations ? JSON.stringify(training_recommendations) : null
  );

  // Update staff's current performance rating
  await prisma.$queryRawUnsafe(
    'UPDATE staff SET performance_rating = $1, last_review_date = CURRENT_DATE WHERE user_id = $2',
    rating, staff_id
  );

  // Create notification for staff member
  await prisma.$queryRawUnsafe(
    `INSERT INTO notifications (
      user_id, title, body, type, related_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    
      staff_id,
      'Performance Review Completed',
      `Your ${review_period} performance review has been completed. Rating: ${rating}/5.0`,
      'performance_review',
      reviewResult[0].id
    
  );

  // Log review activity
  await prisma.$queryRawUnsafe(
    `INSERT INTO hr_activity_logs (
      hr_staff_uid, action, staff_id, description, created_at
    ) VALUES ($1, $2, $3, $4, NOW())`,
    
      reviewerId,
      'PERFORMANCE_REVIEW_CREATED',
      staff_id,
      `Performance review created for ${staff.name} - Rating: ${rating}/5.0`
    
  );

  logger.info(`📝 Performance review created for ${staff.name} (${staff_id}) by ${reviewerName} - Rating: ${rating}/5.0`);

  return {
    review: {
      ...reviewResult[0],
      review_date: reviewResult[0].review_date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      created_at: reviewResult[0].created_at.toLocaleString('en-IN')
    },
    staffInfo: {
      name: staff.name,
      employee_id: staff.employee_id
    }
  };
};