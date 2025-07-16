// services/staff/hrService.js
import db from '../../config/database.js';
import logger from '../../logging/logger.js';

// Get HR Dashboard Data
export const getHRDashboardData = async (timeframe) => {
  // Staff overview statistics
  const staffOverview = await db.query(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.is_active = false THEN 1 END) as inactive_staff,
      COUNT(CASE WHEN s.hire_date >= CURRENT_DATE - INTERVAL '30 days' THEN 1 END) as new_hires_30_days,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as currently_checked_in,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE u.role = ANY($1)
  `, [Object.values(STAFF_ROLES)]);

  // Department staffing levels
  const departmentStats = await db.query(`
    SELECT 
      s.department,
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.last_check_in IS NOT NULL AND s.last_check_out IS NULL THEN 1 END) as present_today,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as avg_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE u.role = ANY($1) AND s.is_active = true
    GROUP BY s.department
    ORDER BY total_staff DESC
  `, [Object.values(STAFF_ROLES)]);

  // Recent attendance trends
  let attendanceTrends = [];
  try {
    const attendanceResult = await db.query(`
      SELECT 
        DATE(check_in_time) as date,
        COUNT(DISTINCT staff_id) as unique_staff,
        AVG(EXTRACT(EPOCH FROM (check_out_time - check_in_time))/3600) as avg_hours
      FROM staff_attendance
      WHERE check_in_time >= CURRENT_DATE - INTERVAL '7 days'
        AND check_out_time IS NOT NULL
      GROUP BY DATE(check_in_time)
      ORDER BY date DESC
      LIMIT 7
    `);

    attendanceTrends = attendanceResult.rows.map(row => ({
      ...row,
      date: new Date(row.date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      avg_hours: row.avg_hours ? Math.round(row.avg_hours * 100) / 100 : 0
    }));
  } catch (attendanceError) {
    logger.warn('Attendance trends unavailable:', attendanceError.message);
  }

  // Performance metrics
  let performanceMetrics = null;
  try {
    const performanceResult = await db.query(`
      SELECT 
        AVG(performance_rating) as avg_performance_rating,
        COUNT(CASE WHEN performance_rating >= 4.0 THEN 1 END) as high_performers,
        COUNT(CASE WHEN performance_rating < 3.0 THEN 1 END) as low_performers
      FROM staff
      WHERE performance_rating IS NOT NULL AND is_active = true
    `);

    if (performanceResult.rows[0].avg_performance_rating) {
      performanceMetrics = {
        ...performanceResult.rows[0],
        avg_performance_rating: Math.round(performanceResult.rows[0].avg_performance_rating * 100) / 100
      };
    }
  } catch (performanceError) {
    logger.warn('Performance metrics unavailable:', performanceError.message);
  }

  // Upcoming reviews and tasks
  let upcomingTasks = [];
  try {
    const tasksResult = await db.query(`
      SELECT 
        'performance_review' as task_type,
        u.name as staff_name,
        s.employee_id,
        s.hire_date + INTERVAL '1 year' as due_date
      FROM users u
      JOIN staff s ON u.id = s.user_id
      WHERE s.is_active = true
        AND s.hire_date + INTERVAL '1 year' BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '30 days'
      ORDER BY due_date ASC
      LIMIT 10
    `);

    upcomingTasks = tasksResult.rows.map(task => ({
      ...task,
      due_date: new Date(task.due_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      })
    }));
  } catch (tasksError) {
    logger.warn('Upcoming tasks unavailable:', tasksError.message);
  }

  return {
    overview: {
      ...staffOverview.rows[0],
      average_salary: staffOverview.rows[0].average_salary ? 
        Math.round(staffOverview.rows[0].average_salary) : null,
      attendance_rate: staffOverview.rows[0].total_staff > 0 ? 
        Math.round((staffOverview.rows[0].currently_checked_in / staffOverview.rows[0].total_staff) * 100) : 0
    },
    departmentBreakdown: departmentStats.rows.map(dept => ({
      ...dept,
      avg_salary: dept.avg_salary ? Math.round(dept.avg_salary) : null,
      attendance_rate: dept.active_staff > 0 ? Math.round((dept.present_today / dept.active_staff) * 100) : 0,
      staffing_status: dept.present_today / dept.active_staff >= 0.8 ? 'adequate' : 'understaffed'
    })),
    attendanceTrends,
    performanceMetrics,
    upcomingTasks,
    alerts: {
      low_attendance: departmentStats.rows.filter(d => (d.present_today / d.active_staff) < 0.7).length,
      upcoming_reviews: upcomingTasks.length,
      new_hires_need_onboarding: parseInt(staffOverview.rows[0].new_hires_30_days) || 0
    },
    lastUpdated: new Date().toISOString()
  };
};

// Generate Performance Report
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
  const performanceData = await db.query(`
    SELECT 
      u.id, u.name, s.employee_id, s.position, s.department,
      s.performance_rating as current_rating,
      COUNT(spr.id) as total_reviews,
      AVG(spr.rating) as average_rating,
      MAX(spr.review_date) as last_review_date,
      STRING_AGG(DISTINCT spr.reviewer_comments, '; ') as recent_comments
    FROM users u
    JOIN staff s ON u.id = s.user_id
    LEFT JOIN staff_performance_reviews spr ON s.user_id = spr.staff_id ${dateFilter}
    ${whereClause}
    GROUP BY u.id, u.name, s.employee_id, s.position, s.department, s.performance_rating
    ORDER BY s.department, average_rating DESC NULLS LAST
  `, queryParams);

  // Department performance averages
  const departmentPerformance = await db.query(`
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
  const performanceDistribution = await db.query(`
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
    staffPerformance: performanceData.rows.map(staff => ({
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
    departmentSummary: departmentPerformance.rows.map(dept => ({
      ...dept,
      avg_current_rating: dept.avg_current_rating ? Math.round(dept.avg_current_rating * 10) / 10 : null,
      avg_review_rating: dept.avg_review_rating ? Math.round(dept.avg_review_rating * 10) / 10 : null
    })),
    performanceDistribution: performanceDistribution.rows,
    insights: {
      totalStaffEvaluated: performanceData.rows.length,
      averageRating: performanceData.rows.length > 0 ? 
        Math.round((performanceData.rows.reduce((sum, s) => sum + (s.current_rating || 0), 0) / performanceData.rows.length) * 10) / 10 : 0,
      highPerformers: performanceData.rows.filter(s => s.current_rating >= 4.0).length,
      needsAttention: performanceData.rows.filter(s => s.current_rating && s.current_rating < 3.0).length
    }
  };
};

// Create Performance Review
export const createPerformanceReview = async (reviewData) => {
  const {
    staff_id, rating, review_period, reviewer_comments,
    goals_achieved, areas_for_improvement, future_goals,
    training_recommendations, reviewerId, reviewerName
  } = reviewData;

  // Verify staff member exists
  const staffCheck = await db.query(
    'SELECT u.name, s.employee_id FROM users u JOIN staff s ON u.id = s.user_id WHERE u.id = $1',
    [staff_id]
  );

  if (staffCheck.rows.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffCheck.rows[0];

  // Create performance review
  const reviewResult = await db.query(`
    INSERT INTO staff_performance_reviews (
      staff_id, reviewer_id, rating, review_period, reviewer_comments,
      goals_achieved, areas_for_improvement, future_goals,
      training_recommendations, review_date, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CURRENT_DATE, NOW())
    RETURNING *
  `, [
    staff_id, reviewerId, rating, review_period, reviewer_comments,
    goals_achieved ? JSON.stringify(goals_achieved) : null,
    areas_for_improvement ? JSON.stringify(areas_for_improvement) : null,
    future_goals ? JSON.stringify(future_goals) : null,
    training_recommendations ? JSON.stringify(training_recommendations) : null
  ]);

  // Update staff's current performance rating
  await db.query(
    'UPDATE staff SET performance_rating = $1, last_review_date = CURRENT_DATE WHERE user_id = $2',
    [rating, staff_id]
  );

  // Create notification for staff member
  await db.query(
    `INSERT INTO notifications (
      user_id, title, body, type, related_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, NOW())`,
    [
      staff_id,
      'Performance Review Completed',
      `Your ${review_period} performance review has been completed. Rating: ${rating}/5.0`,
      'performance_review',
      reviewResult.rows[0].id
    ]
  );

  // Log review activity
  await db.query(
    `INSERT INTO hr_activity_logs (
      hr_staff_uid, action, staff_id, description, created_at
    ) VALUES ($1, $2, $3, $4, NOW())`,
    [
      reviewerId,
      'PERFORMANCE_REVIEW_CREATED',
      staff_id,
      `Performance review created for ${staff.name} - Rating: ${rating}/5.0`
    ]
  );

  logger.info(`📝 Performance review created for ${staff.name} (${staff_id}) by ${reviewerName} - Rating: ${rating}/5.0`);

  return {
    review: {
      ...reviewResult.rows[0],
      review_date: reviewResult.rows[0].review_date.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      created_at: reviewResult.rows[0].created_at.toLocaleString('en-IN')
    },
    staffInfo: {
      name: staff.name,
      employee_id: staff.employee_id
    }
  };
};

// Get Onboarding Checklist
export const getOnboardingChecklist = async (staffId) => {
  // Get staff information
  const staffInfo = await db.query(`
    SELECT u.name, u.email, u.phone, s.employee_id, s.position, 
           s.department, s.hire_date, s.supervisor_id
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE u.id = $1
  `, [staffId]);

  if (staffInfo.rows.length === 0) {
    return null;
  }

  const staff = staffInfo.rows[0];

  // Get onboarding checklist
  let onboardingTasks = [];
  try {
    const tasksResult = await db.query(`
      SELECT task_name, description, completed, completed_date, 
             assigned_to, due_date, priority
      FROM staff_onboarding_tasks
      WHERE staff_id = $1
      ORDER BY priority DESC, due_date ASC
    `, [staffId]);

    onboardingTasks = tasksResult.rows.map(task => ({
      ...task,
      completed_date: task.completed_date ? new Date(task.completed_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : null,
      due_date: task.due_date ? new Date(task.due_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : null
    }));
  } catch (tasksError) {
    // Provide default onboarding checklist if table doesn't exist
    onboardingTasks = [
      { task_name: 'Complete employment paperwork', description: 'Fill out tax forms, emergency contacts, etc.', completed: false, priority: 'high' },
      { task_name: 'System access setup', description: 'Create user accounts and assign permissions', completed: false, priority: 'high' },
      { task_name: 'Department orientation', description: 'Meet team members and understand workflows', completed: false, priority: 'medium' },
      { task_name: 'Safety training', description: 'Complete workplace safety and emergency procedures', completed: false, priority: 'high' },
      { task_name: 'Job-specific training', description: 'Role-specific skills and procedures training', completed: false, priority: 'medium' },
      { task_name: '30-day check-in', description: 'Review progress and address any concerns', completed: false, priority: 'low' }
    ];
  }

  // Calculate progress
  const completedTasks = onboardingTasks.filter(task => task.completed).length;
  const totalTasks = onboardingTasks.length;
  const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Days since hire
  const daysSinceHire = Math.floor((new Date() - new Date(staff.hire_date)) / (1000 * 60 * 60 * 24));

  return {
    staffInfo: {
      ...staff,
      hire_date: new Date(staff.hire_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      days_since_hire: daysSinceHire
    },
    onboardingProgress: {
      completed_tasks: completedTasks,
      total_tasks: totalTasks,
      progress_percentage: progressPercentage,
      status: progressPercentage === 100 ? 'completed' : 
             progressPercentage >= 75 ? 'nearly_complete' :
             progressPercentage >= 50 ? 'in_progress' : 'just_started'
    },
    tasks: onboardingTasks,
    recommendations: daysSinceHire <= 30 ? [
      'Schedule regular check-ins during first month',
      'Assign a workplace buddy or mentor',
      'Provide clear role expectations and goals',
      'Ensure all safety training is completed promptly'
    ] : []
  };
};

// Check if user is viewing their own onboarding
export const isUserViewingOwnOnboarding = async (staffId, userUid) => {
  const result = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    [staffId, userUid]
  );
  return result.rows.length > 0;
};

// Check if user is viewing their own data
export const isUserViewingOwnData = async (staffId, userUid) => {
  const result = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    [staffId, userUid]
  );
  return result.rows.length > 0;
};

// Check if user is applying for their own leave
export const isUserApplyingOwnLeave = async (staffId, userUid) => {
  const result = await db.query(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    [staffId, userUid]
  );
  return result.rows.length > 0;
};

// Update onboarding task
export const updateOnboardingTask = async (staffId, taskId, completed, completedBy) => {
  const result = await db.query(`
    UPDATE staff_onboarding_tasks 
    SET completed = $1, 
        completed_date = CASE WHEN $1 = true THEN NOW() ELSE NULL END,
        completed_by = $2,
        updated_at = NOW()
    WHERE staff_id = $3 AND id = $4
    RETURNING *
  `, [completed, completedBy, staffId, taskId]);

  if (result.rows.length === 0) {
    return null;
  }

  return {
    task: result.rows[0],
    message: completed ? 'Task marked as completed' : 'Task marked as incomplete'
  };
};

// Get staff leave balance
export const getStaffLeaveBalance = async (staffId, year) => {
  const staffCheck = await db.query(
    'SELECT u.name, s.employee_id, s.hire_date FROM users u JOIN staff s ON u.id = s.user_id WHERE u.id = $1',
    [staffId]
  );

  if (staffCheck.rows.length === 0) {
    return null;
  }

  const staff = staffCheck.rows[0];

  // Get leave entitlement and usage
  const leaveData = await db.query(`
    SELECT 
      lt.leave_type,
      lt.annual_entitlement,
      COALESCE(SUM(la.days_taken), 0) as days_used,
      lt.annual_entitlement - COALESCE(SUM(la.days_taken), 0) as days_remaining
    FROM leave_types lt
    LEFT JOIN leave_applications la ON lt.leave_type = la.leave_type 
      AND la.staff_id = $1 
      AND EXTRACT(YEAR FROM la.start_date) = $2
      AND la.status = 'APPROVED'
    GROUP BY lt.leave_type, lt.annual_entitlement
    ORDER BY lt.leave_type
  `, [staffId, year]);

  // Get leave history
  const leaveHistory = await db.query(`
    SELECT 
      leave_type,
      start_date,
      end_date,
      days_taken,
      status,
      reason,
      approved_by,
      approved_date
    FROM leave_applications
    WHERE staff_id = $1 AND EXTRACT(YEAR FROM start_date) = $2
    ORDER BY start_date DESC
  `, [staffId, year]);

  return {
    staff: {
      name: staff.name,
      employee_id: staff.employee_id,
      hire_date: new Date(staff.hire_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      })
    },
    year,
    leaveBalance: leaveData.rows,
    leaveHistory: leaveHistory.rows.map(leave => ({
      ...leave,
      start_date: new Date(leave.start_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      end_date: new Date(leave.end_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      approved_date: leave.approved_date ? new Date(leave.approved_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : null
    })),
    summary: {
      total_entitled: leaveData.rows.reduce((sum, leave) => sum + leave.annual_entitlement, 0),
      total_used: leaveData.rows.reduce((sum, leave) => sum + parseFloat(leave.days_used), 0),
      total_remaining: leaveData.rows.reduce((sum, leave) => sum + leave.days_remaining, 0)
    }
  };
};

// Apply for Leave
export const applyForLeave = async (leaveData) => {
  const {
    staff_id,
    leave_type,
    start_date,
    end_date,
    reason,
    emergency_contact,
    appliedBy
  } = leaveData;

  // Calculate days requested
  const startDate = new Date(start_date);
  const endDate = new Date(end_date);
  const daysDifference = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;

  // Validate date range
  if (daysDifference <= 0 || startDate > endDate) {
    throw new Error('INVALID_DATE_RANGE');
  }

  // Check leave balance
  const balanceCheck = await db.query(`
    SELECT 
      lt.annual_entitlement,
      COALESCE(SUM(la.days_taken), 0) as days_used,
      lt.annual_entitlement - COALESCE(SUM(la.days_taken), 0) as days_remaining
    FROM leave_types lt
    LEFT JOIN leave_applications la ON lt.leave_type = la.leave_type 
      AND la.staff_id = $1 
      AND EXTRACT(YEAR FROM la.start_date) = EXTRACT(YEAR FROM $2::date)
      AND la.status = 'APPROVED'
    WHERE lt.leave_type = $3
    GROUP BY lt.leave_type, lt.annual_entitlement
  `, [staff_id, start_date, leave_type]);

  if (balanceCheck.rows.length === 0 || balanceCheck.rows[0].days_remaining < daysDifference) {
    throw new Error('INSUFFICIENT_LEAVE_BALANCE');
  }

  // Get staff details
  const staffInfo = await db.query(
    'SELECT u.name, s.employee_id, s.department, s.supervisor_id FROM users u JOIN staff s ON u.id = s.user_id WHERE u.id = $1',
    [staff_id]
  );

  if (staffInfo.rows.length === 0) {
    throw new Error('STAFF_NOT_FOUND');
  }

  const staff = staffInfo.rows[0];

  // Create leave application
  const applicationResult = await db.query(`
    INSERT INTO leave_applications (
      staff_id, leave_type, start_date, end_date, days_taken,
      reason, emergency_contact, status, applied_by, applied_date,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())
    RETURNING *
  `, [
    staff_id, leave_type, start_date, end_date, daysDifference,
    reason, emergency_contact, 'PENDING', appliedBy
  ]);

  // Create notification for supervisor
  if (staff.supervisor_id) {
    await db.query(
      `INSERT INTO notifications (
        user_id, title, body, type, related_id, created_at
      ) VALUES ($1, $2, $3, $4, $5, NOW())`,
      [
        staff.supervisor_id,
        'Leave Application Pending Approval',
        `${staff.name} has applied for ${leave_type} from ${startDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })} to ${endDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })}`,
        'leave_application',
        applicationResult.rows[0].id
      ]
    );
  }

  logger.info(`📅 Leave application created for ${staff.name} (${staff_id}) - ${leave_type} for ${daysDifference} days`);

  return {
    application: {
      ...applicationResult.rows[0],
      start_date: startDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      end_date: endDate.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      applied_date: new Date(applicationResult.rows[0].applied_date).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
    },
    staffInfo: {
      name: staff.name,
      employee_id: staff.employee_id,
      department: staff.department
    },
    leaveBalance: {
      days_requested: daysDifference,
      days_remaining_before: balanceCheck.rows[0].days_remaining,
      days_remaining_after: balanceCheck.rows[0].days_remaining - daysDifference
    }
  };
};

// Get Department Staff Summary
export const getDepartmentStaffSummary = async (department) => {
  // Basic department statistics
  const departmentStats = await db.query(`
    SELECT 
      COUNT(*) as total_staff,
      COUNT(CASE WHEN s.is_active = true THEN 1 END) as active_staff,
      COUNT(CASE WHEN s.employment_type = 'FULL_TIME' THEN 1 END) as full_time,
      COUNT(CASE WHEN s.employment_type = 'PART_TIME' THEN 1 END) as part_time,
      COUNT(CASE WHEN s.employment_type = 'CONTRACT' THEN 1 END) as contract,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as average_salary,
      MIN(s.salary) FILTER (WHERE s.salary IS NOT NULL) as min_salary,
      MAX(s.salary) FILTER (WHERE s.salary IS NOT NULL) as max_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1
  `, [department]);

  // Staff by position
  const positionBreakdown = await db.query(`
    SELECT 
      s.position,
      COUNT(*) as count,
      AVG(s.salary) FILTER (WHERE s.salary IS NOT NULL) as avg_salary
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true
    GROUP BY s.position
    ORDER BY count DESC
  `, [department]);

  // Staff by shift
  const shiftBreakdown = await db.query(`
    SELECT 
      s.shift_type,
      COUNT(*) as count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true AND s.shift_type IS NOT NULL
    GROUP BY s.shift_type
    ORDER BY count DESC
  `, [department]);

  // Experience distribution
  const experienceDistribution = await db.query(`
    SELECT 
      CASE
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '1 year' THEN '0-1 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '3 years' THEN '1-3 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '5 years' THEN '3-5 years'
        WHEN AGE(NOW(), s.hire_date) < INTERVAL '10 years' THEN '5-10 years'
        ELSE '10+ years'
      END as experience_range,
      COUNT(*) as count
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE s.department = $1 AND s.is_active = true
    GROUP BY experience_range
    ORDER BY 
      CASE experience_range
        WHEN '0-1 years' THEN 1
        WHEN '1-3 years' THEN 2
        WHEN '3-5 years' THEN 3
        WHEN '5-10 years' THEN 4
        ELSE 5
      END
  `, [department]);

  // Recent attendance
  const attendanceMetrics = await db.query(`
    SELECT 
      COUNT(DISTINCT sa.staff_id) as staff_present_today,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) as avg_hours_today
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    WHERE s.department = $1 
      AND DATE(sa.check_in_time) = CURRENT_DATE
      AND sa.check_out_time IS NOT NULL
  `, [department]);

  // Performance metrics
  const performanceMetrics = await db.query(`
    SELECT 
      AVG(s.performance_rating) as avg_performance,
      COUNT(CASE WHEN s.performance_rating >= 4.0 THEN 1 END) as high_performers,
      COUNT(CASE WHEN s.performance_rating < 3.0 THEN 1 END) as needs_improvement
    FROM staff s
    WHERE s.department = $1 AND s.is_active = true AND s.performance_rating IS NOT NULL
  `, [department]);

  // Staff list
  const staffList = await db.query(`
    SELECT 
      u.id, u.name, u.email, u.phone,
      s.employee_id, s.position, s.shift_type, s.employment_type,
      s.hire_date, s.performance_rating,
      CASE 
        WHEN sa.check_in_time IS NOT NULL AND sa.check_out_time IS NULL THEN 'present'
        WHEN sa.check_in_time IS NOT NULL THEN 'checked_out'
        ELSE 'absent'
      END as attendance_status
    FROM users u
    JOIN staff s ON u.id = s.user_id
    LEFT JOIN staff_attendance sa ON s.user_id = sa.staff_id 
      AND DATE(sa.check_in_time) = CURRENT_DATE
    WHERE s.department = $1 AND s.is_active = true
    ORDER BY s.position, u.name
  `, [department]);

  const stats = departmentStats.rows[0];
  const attendance = attendanceMetrics.rows[0];
  const performance = performanceMetrics.rows[0];

  return {
    department,
    overview: {
      total_staff: parseInt(stats.total_staff) || 0,
      active_staff: parseInt(stats.active_staff) || 0,
      full_time: parseInt(stats.full_time) || 0,
      part_time: parseInt(stats.part_time) || 0,
      contract: parseInt(stats.contract) || 0,
      attendance_today: parseInt(attendance.staff_present_today) || 0,
      attendance_rate: stats.active_staff > 0 ? 
        Math.round((attendance.staff_present_today / stats.active_staff) * 100) : 0,
      avg_hours_today: attendance.avg_hours_today ? 
        Math.round(attendance.avg_hours_today * 10) / 10 : 0
    },
    salary: {
      average: stats.average_salary ? Math.round(stats.average_salary) : null,
      minimum: stats.min_salary ? Math.round(stats.min_salary) : null,
      maximum: stats.max_salary ? Math.round(stats.max_salary) : null
    },
    performance: {
      average_rating: performance.avg_performance ? 
        Math.round(performance.avg_performance * 10) / 10 : null,
      high_performers: parseInt(performance.high_performers) || 0,
      needs_improvement: parseInt(performance.needs_improvement) || 0
    },
    positionBreakdown: positionBreakdown.rows.map(pos => ({
      position: pos.position,
      count: parseInt(pos.count),
      avg_salary: pos.avg_salary ? Math.round(pos.avg_salary) : null
    })),
    shiftBreakdown: shiftBreakdown.rows,
    experienceDistribution: experienceDistribution.rows,
    staffList: staffList.rows.map(staff => ({
      ...staff,
      hire_date: new Date(staff.hire_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }),
      tenure: Math.floor((new Date() - new Date(staff.hire_date)) / (365.25 * 24 * 60 * 60 * 1000)),
      performance_rating: staff.performance_rating ? 
        Math.round(staff.performance_rating * 10) / 10 : null
    }))
  };
};

// Get Attendance Analytics
export const getAttendanceAnalytics = async (queryParams) => {
  const { department, start_date, end_date, group_by } = queryParams;

  let whereClause = 'WHERE sa.check_in_time IS NOT NULL';
  let paramIndex = 1;

  if (department) {
    whereClause += ` AND s.department = $${paramIndex}`;
    queryParams.push(department);
    paramIndex++;
  }

  if (start_date && end_date) {
    whereClause += ` AND DATE(sa.check_in_time) BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
    queryParams.push(start_date, end_date);
    paramIndex += 2;
  }

  // Attendance overview
  const overview = await db.query(`
    SELECT 
      COUNT(DISTINCT sa.staff_id) as unique_staff,
      COUNT(*) as total_check_ins,
      COUNT(CASE WHEN sa.check_out_time IS NOT NULL THEN 1 END) as completed_shifts,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours_worked,
      COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals,
      COUNT(CASE WHEN sa.overtime_hours > 0 THEN 1 END) as overtime_shifts
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
  `, queryParams);

  // Group by time period
  let groupByClause;
  let dateFormat;
  
  switch (group_by) {
    case 'week':
      groupByClause = "DATE_TRUNC('week', sa.check_in_time)";
      dateFormat = "to_char(DATE_TRUNC('week', sa.check_in_time), 'DD-MM-YYYY')";
      break;
    case 'month':
      groupByClause = "DATE_TRUNC('month', sa.check_in_time)";
      dateFormat = "to_char(DATE_TRUNC('month', sa.check_in_time), 'Mon YYYY')";
      break;
    default: // day
      groupByClause = "DATE(sa.check_in_time)";
      dateFormat = "to_char(DATE(sa.check_in_time), 'DD-MM-YYYY')";
  }

  const trendsData = await db.query(`
    SELECT 
      ${dateFormat} as period,
      COUNT(DISTINCT sa.staff_id) as unique_staff,
      COUNT(*) as total_check_ins,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
      COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals,
      SUM(sa.overtime_hours) as total_overtime_hours
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
    GROUP BY ${groupByClause}
    ORDER BY ${groupByClause} DESC
    LIMIT 30
  `, queryParams);

  // Department comparison (if not filtering by department)
  let departmentComparison = [];
  if (!department) {
    const deptResult = await db.query(`
      SELECT 
        s.department,
        COUNT(DISTINCT sa.staff_id) as unique_staff,
        COUNT(*) as total_check_ins,
        AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
          FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
        COUNT(CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 1 END) as late_arrivals
      FROM staff_attendance sa
      JOIN staff s ON sa.staff_id = s.user_id
      WHERE sa.check_in_time IS NOT NULL
        ${start_date && end_date ? `AND DATE(sa.check_in_time) BETWEEN $1 AND $2` : ''}
      GROUP BY s.department
      ORDER BY total_check_ins DESC
    `, start_date && end_date ? [start_date, end_date] : []);
    
    departmentComparison = deptResult.rows;
  }

  // Punctuality analysis
  const punctualityData = await db.query(`
    SELECT 
      CASE 
        WHEN TIME(sa.check_in_time) <= '09:00:00' THEN 'on_time'
        WHEN TIME(sa.check_in_time) <= '09:30:00' THEN 'slightly_late'
        WHEN TIME(sa.check_in_time) <= '10:00:00' THEN 'late'
        ELSE 'very_late'
      END as punctuality,
      COUNT(*) as count
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    ${whereClause}
    GROUP BY punctuality
    ORDER BY 
      CASE punctuality
        WHEN 'on_time' THEN 1
        WHEN 'slightly_late' THEN 2
        WHEN 'late' THEN 3
        ELSE 4
      END
  `, queryParams);

  // Top performers (most consistent attendance)
  const topPerformers = await db.query(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      COUNT(*) as days_present,
      AVG(EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600) 
        FILTER (WHERE sa.check_out_time IS NOT NULL) as avg_hours,
      COUNT(CASE WHEN TIME(sa.check_in_time) <= '09:00:00' THEN 1 END) as on_time_days,
      SUM(sa.overtime_hours) as total_overtime
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    GROUP BY u.name, s.employee_id, s.department
    HAVING COUNT(*) > 5
    ORDER BY days_present DESC, on_time_days DESC
    LIMIT 10
  `, queryParams);

  const overviewData = overview.rows[0];

  return {
    filters: {
      department: department || 'All Departments',
      date_range: start_date && end_date ? 
        { start: start_date, end: end_date } : 'All Time',
      grouping: group_by
    },
    summary: {
      unique_staff: parseInt(overviewData.unique_staff) || 0,
      total_check_ins: parseInt(overviewData.total_check_ins) || 0,
      completed_shifts: parseInt(overviewData.completed_shifts) || 0,
      avg_hours_worked: overviewData.avg_hours_worked ? 
        Math.round(overviewData.avg_hours_worked * 10) / 10 : 0,
      late_arrivals: parseInt(overviewData.late_arrivals) || 0,
      late_arrival_rate: overviewData.total_check_ins > 0 ?
        Math.round((overviewData.late_arrivals / overviewData.total_check_ins) * 100) : 0,
      overtime_shifts: parseInt(overviewData.overtime_shifts) || 0
    },
    trends: trendsData.rows.map(trend => ({
      period: trend.period,
      unique_staff: parseInt(trend.unique_staff),
      total_check_ins: parseInt(trend.total_check_ins),
      avg_hours: trend.avg_hours ? Math.round(trend.avg_hours * 10) / 10 : 0,
      late_arrivals: parseInt(trend.late_arrivals),
      total_overtime_hours: parseFloat(trend.total_overtime_hours) || 0
    })),
    departmentComparison: departmentComparison.map(dept => ({
      department: dept.department,
      unique_staff: parseInt(dept.unique_staff),
      total_check_ins: parseInt(dept.total_check_ins),
      avg_hours: dept.avg_hours ? Math.round(dept.avg_hours * 10) / 10 : 0,
      late_arrivals: parseInt(dept.late_arrivals),
      punctuality_score: dept.total_check_ins > 0 ?
        Math.round(((dept.total_check_ins - dept.late_arrivals) / dept.total_check_ins) * 100) : 0
    })),
    punctualityBreakdown: punctualityData.rows,
    topPerformers: topPerformers.rows.map(performer => ({
      ...performer,
      avg_hours: performer.avg_hours ? Math.round(performer.avg_hours * 10) / 10 : 0,
      punctuality_rate: performer.days_present > 0 ?
        Math.round((performer.on_time_days / performer.days_present) * 100) : 0,
      total_overtime: parseFloat(performer.total_overtime) || 0
    }))
  };
};

// Generate Staff Report
export const generateStaffReport = async (reportParams) => {
  const {
    report_type,
    department,
    start_date,
    end_date,
    format,
    generatedBy
  } = reportParams;

  let reportData;
  
  switch (report_type) {
    case 'attendance':
      reportData = await generateAttendanceReport(department, start_date, end_date);
      break;
    case 'performance':
      reportData = await generatePerformanceReportData(department, start_date, end_date);
      break;
    case 'leave':
      reportData = await generateLeaveReport(department, start_date, end_date);
      break;
    case 'payroll':
      reportData = await generatePayrollReport(department, start_date, end_date);
      break;
    default:
      throw new Error('Invalid report type');
  }

  if (format === 'csv') {
    return {
      data: convertToCSV(reportData)
    };
  }

  return {
    report_type,
    department: department || 'All Departments',
    date_range: { start_date, end_date },
    generated_by: generatedBy,
    generated_at: new Date().toISOString(),
    data: reportData
  };
};

// Helper function to generate attendance report data
const generateAttendanceReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE sa.check_in_time IS NOT NULL';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }
  
  if (start_date && end_date) {
    const paramOffset = queryParams.length;
    whereClause += ` AND DATE(sa.check_in_time) BETWEEN $${paramOffset + 1} AND $${paramOffset + 2}`;
    queryParams.push(start_date, end_date);
  }

  const result = await db.query(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      DATE(sa.check_in_time) as date,
      sa.check_in_time,
      sa.check_out_time,
      EXTRACT(EPOCH FROM (sa.check_out_time - sa.check_in_time))/3600 as hours_worked,
      sa.overtime_hours,
      CASE WHEN TIME(sa.check_in_time) > '09:30:00' THEN 'Late' ELSE 'On Time' END as punctuality
    FROM staff_attendance sa
    JOIN staff s ON sa.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY date DESC, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    date: new Date(row.date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }),
    check_in_time: new Date(row.check_in_time).toLocaleTimeString('en-IN'),
    check_out_time: row.check_out_time ? 
      new Date(row.check_out_time).toLocaleTimeString('en-IN') : 'Not checked out',
    hours_worked: row.hours_worked ? Math.round(row.hours_worked * 10) / 10 : 0,
    overtime_hours: row.overtime_hours || 0
  }));
};

// Helper function to convert data to CSV
const convertToCSV = (data) => {
  if (!data || data.length === 0) {return '';}
  
  const headers = Object.keys(data[0]);
  const csvHeaders = headers.join(',');
  
  const csvRows = data.map(row => {
    return headers.map(header => {
      const value = row[header];
      // Escape quotes and wrap in quotes if contains comma
      if (typeof value === 'string' && (value.includes(',') || value.includes('"'))) {
        return `"${value.replace(/"/g, '""')}"`;
      }
      return value;
    }).join(',');
  });
  
  return [csvHeaders, ...csvRows].join('\n');
};

// Helper function to generate performance report data
const generatePerformanceReportData = async (department, start_date, end_date) => {
  let whereClause = 'WHERE s.is_active = true';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }

  const result = await db.query(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      s.performance_rating,
      s.last_review_date
    FROM staff s
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY s.department, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    performance_rating: row.performance_rating ? 
      Math.round(row.performance_rating * 10) / 10 : 'Not rated',
    last_review_date: row.last_review_date ? 
      new Date(row.last_review_date).toLocaleDateString('en-GB', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
      }) : 'Never reviewed'
  }));
};

// Helper function to generate leave report data
const generateLeaveReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE la.staff_id IS NOT NULL';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }
  
  if (start_date && end_date) {
    const paramOffset = queryParams.length;
    whereClause += ` AND la.start_date BETWEEN $${paramOffset + 1} AND $${paramOffset + 2}`;
    queryParams.push(start_date, end_date);
  }

  const result = await db.query(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      la.leave_type,
      la.start_date,
      la.end_date,
      la.days_taken,
      la.status,
      la.reason
    FROM leave_applications la
    JOIN staff s ON la.staff_id = s.user_id
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY la.start_date DESC, u.name
  `, queryParams);

  return result.rows.map(row => ({
    ...row,
    start_date: new Date(row.start_date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    }),
    end_date: new Date(row.end_date).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric'
    })
  }));
};

// Helper function to generate payroll report data
const generatePayrollReport = async (department, start_date, end_date) => {
  let whereClause = 'WHERE s.is_active = true';
  const queryParams = [];
  
  if (department) {
    whereClause += ' AND s.department = $1';
    queryParams.push(department);
  }

  const result = await db.query(`
    SELECT 
      u.name,
      s.employee_id,
      s.department,
      s.position,
      s.employment_type,
      s.salary,
      s.bank_details
    FROM staff s
    JOIN users u ON s.user_id = u.id
    ${whereClause}
    ORDER BY s.department, u.name
  `, queryParams);

  return result.rows.map(row => ({
    name: row.name,
    employee_id: row.employee_id,
    department: row.department,
    position: row.position,
    employment_type: row.employment_type,
    monthly_salary: row.salary || 0,
    bank_account: row.bank_details?.account_number ? 
      `****${row.bank_details.account_number.slice(-4)}` : 'Not provided'
  }));
};