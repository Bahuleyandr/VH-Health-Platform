// src/services/staff/hr/onboardingService.js
import prisma from '../../../lib/prisma.js';
import logger from '../../../logging/logger.js';

/**
 * Get onboarding checklist for a staff member
 * @param {number} staffId - Staff ID
 * @returns {Object} Onboarding checklist and progress
 */
export const getOnboardingChecklist = async (staffId) => {
  // Get staff information
  const staffInfo = await prisma.$queryRawUnsafe(`
    SELECT u.name, u.email, u.phone, s.employee_id, s.position, 
           s.department, s.hire_date, s.supervisor_id
    FROM users u
    JOIN staff s ON u.id = s.user_id
    WHERE u.id = $1
  `, [staffId]);

  if (staffInfo.length === 0) {
    return null;
  }

  const staff = staffInfo[0];

  // Get onboarding checklist
  let onboardingTasks = [];
  try {
    const tasksResult = await prisma.$queryRawUnsafe(`
      SELECT task_name, description, completed, completed_date, 
             assigned_to, due_date, priority
      FROM staff_onboarding_tasks
      WHERE staff_id = $1
      ORDER BY priority DESC, due_date ASC
    `, [staffId]);

    onboardingTasks = tasksResult.map(task => ({
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

/**
 * Update onboarding task status
 * @param {number} staffId - Staff ID
 * @param {number} taskId - Task ID
 * @param {boolean} completed - Completion status
 * @param {string} completedBy - ID of person marking task complete
 * @returns {Object} Updated task details
 */
export const updateOnboardingTask = async (staffId, taskId, completed, completedBy) => {
  const result = await prisma.$queryRawUnsafe(`
    UPDATE staff_onboarding_tasks 
    SET completed = $1, 
        completed_date = CASE WHEN $1 = true THEN NOW() ELSE NULL END,
        completed_by = $2,
        updated_at = NOW()
    WHERE staff_id = $3 AND id = $4
    RETURNING id, staff_id, task_name, description, completed, completed_date, completed_by, updated_at
  `, [completed, completedBy, staffId, taskId]);

  if (result.length === 0) {
    return null;
  }

  return {
    task: result[0],
    message: completed ? 'Task marked as completed' : 'Task marked as incomplete'
  };
};

/**
 * Check if user is viewing their own onboarding
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if viewing own onboarding
 */
export const isUserViewingOwnOnboarding = async (staffId, userUid) => {
  const result = await prisma.$queryRawUnsafe(
    'SELECT 1 FROM users WHERE id = $1 AND uid = $2',
    [staffId, userUid]
  );
  return result.length > 0;
};