// src/services/staff/hr/onboardingService.js
import prisma from '../../../lib/prisma.js';

// Default checklist returned when a staff member has no seeded tasks.
// Matches the historic fallback shape; priority + description now align
// with the real staff_onboarding_tasks schema after migration 091.
const DEFAULT_CHECKLIST = [
  { task_name: 'Complete employment paperwork', description: 'Fill out tax forms, emergency contacts, etc.', completed: false, priority: 'high' },
  { task_name: 'System access setup', description: 'Create user accounts and assign permissions', completed: false, priority: 'high' },
  { task_name: 'Department orientation', description: 'Meet team members and understand workflows', completed: false, priority: 'medium' },
  { task_name: 'Safety training', description: 'Complete workplace safety and emergency procedures', completed: false, priority: 'high' },
  { task_name: 'Job-specific training', description: 'Role-specific skills and procedures training', completed: false, priority: 'medium' },
  { task_name: '30-day check-in', description: 'Review progress and address any concerns', completed: false, priority: 'low' },
];

const fmtDate = (d) => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' })
  : null;

/**
 * Get onboarding checklist for a staff member
 * @param {number} staffId - Staff ID
 * @returns {Object} Onboarding checklist and progress
 */
export const getOnboardingChecklist = async (staffId) => {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: {
      name: true,
      email: true,
      phone: true,
      staff: {
        select: {
          employee_id: true,
          position: true,
          department: true,
          hire_date: true,
          supervisor_id: true,
        },
        take: 1,
      },
    },
  });

  if (!user || user.staff.length === 0) {
    return null;
  }

  const [staff] = user.staff;

  // Load per-staff onboarding tasks. The raw version here previously
  // failed with a try/catch fallback because description/assigned_to/
  // due_date/priority didn't exist on the schema — batch 91 added them.
  let taskRows;
  try {
    taskRows = await prisma.staff_onboarding_tasks.findMany({
      where: { staff_id: Number(staffId) },
      select: {
        id: true,
        task_name: true,
        description: true,
        completed: true,
        completed_date: true,
        assigned_to: true,
        due_date: true,
        priority: true,
      },
      orderBy: [
        { priority: 'desc' },
        { due_date: 'asc' },
      ],
    });
  } catch {
    taskRows = null;
  }

  const onboardingTasks = taskRows && taskRows.length > 0
    ? taskRows.map((task) => ({
      ...task,
      completed_date: fmtDate(task.completed_date),
      due_date: fmtDate(task.due_date),
    }))
    : DEFAULT_CHECKLIST;

  // Calculate progress.
  const completedTasks = onboardingTasks.filter((task) => task.completed).length;
  const totalTasks = onboardingTasks.length;
  const progressPercentage = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  // Days since hire.
  const daysSinceHire = staff.hire_date
    ? Math.floor((new Date() - new Date(staff.hire_date)) / (1000 * 60 * 60 * 24))
    : 0;

  return {
    staffInfo: {
      name: user.name,
      email: user.email,
      phone: user.phone,
      employee_id: staff.employee_id,
      position: staff.position,
      department: staff.department,
      supervisor_id: staff.supervisor_id,
      hire_date: fmtDate(staff.hire_date),
      days_since_hire: daysSinceHire,
    },
    onboardingProgress: {
      completed_tasks: completedTasks,
      total_tasks: totalTasks,
      progress_percentage: progressPercentage,
      status: progressPercentage === 100 ? 'completed' :
        progressPercentage >= 75 ? 'nearly_complete' :
          progressPercentage >= 50 ? 'in_progress' : 'just_started',
    },
    tasks: onboardingTasks,
    recommendations: daysSinceHire <= 30 ? [
      'Schedule regular check-ins during first month',
      'Assign a workplace buddy or mentor',
      'Provide clear role expectations and goals',
      'Ensure all safety training is completed promptly',
    ] : [],
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
  // Prisma's update(where: {id}) throws if not found; use updateMany
  // with the compound predicate so the "not found" case is a 0-count
  // rather than an exception (matches the raw version's null return).
  const updated = await prisma.staff_onboarding_tasks.updateMany({
    where: { id: Number(taskId), staff_id: Number(staffId) },
    data: {
      completed,
      completed_date: completed ? new Date() : null,
      completed_by: completedBy,
      updated_at: new Date(),
    },
  });

  if (updated.count === 0) return null;

  const task = await prisma.staff_onboarding_tasks.findUnique({
    where: { id: Number(taskId) },
    select: {
      id: true, staff_id: true, task_name: true, description: true,
      completed: true, completed_date: true, completed_by: true, updated_at: true,
    },
  });

  return {
    task,
    message: completed ? 'Task marked as completed' : 'Task marked as incomplete',
  };
};

/**
 * Check if user is viewing their own onboarding
 * @param {number} staffId - Staff ID
 * @param {string} userUid - User UID
 * @returns {boolean} True if viewing own onboarding
 */
export const isUserViewingOwnOnboarding = async (staffId, userUid) => {
  const user = await prisma.users.findUnique({
    where: { id: Number(staffId) },
    select: { uid: true },
  });
  return user?.uid === userUid;
};
