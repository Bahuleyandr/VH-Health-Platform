// validators/staff/hrValidators.js
import { body, query, param } from 'express-validator';

const STAFF_IDENTIFIER_RE = /^(?:\d+|EMP-[A-Z0-9-]+|[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;

// Performance Review Validation
export const performanceReviewValidation = [
  body('staff_id')
    .custom((value) => STAFF_IDENTIFIER_RE.test(String(value || '').trim()))
    .withMessage('Staff ID must be a valid integer, employee ID, or UUID'),
  body('rating').isFloat({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
  body('review_period').notEmpty().withMessage('Review period is required'),
  body('reviewer_comments').notEmpty().withMessage('Reviewer comments are required'),
  body('goals_achieved').optional().isArray().withMessage('Goals achieved must be an array'),
  body('areas_for_improvement').optional().isArray().withMessage('Areas for improvement must be an array'),
  body('future_goals').optional().isArray().withMessage('Future goals must be an array'),
  body('training_recommendations').optional().isArray().withMessage('Training recommendations must be an array')
];

// Onboarding Validation
export const onboardingValidation = [
  param('staff_id').isInt().withMessage('Staff ID must be a valid integer')
];

// Update Onboarding Task Validation
export const updateOnboardingTaskValidation = [
  param('staff_id').isInt().withMessage('Staff ID must be a valid integer'),
  body('task_id').isInt().withMessage('Task ID must be a valid integer'),
  body('completed').isBoolean().withMessage('Completed must be a boolean value')
];

// Leave Application Validation
export const leaveApplicationValidation = [
  body('staff_id')
    .custom((value) => STAFF_IDENTIFIER_RE.test(String(value || '').trim()))
    .withMessage('Staff ID must be a valid integer, employee ID, or UUID'),
  body('leave_type').isIn(['ANNUAL', 'SICK', 'CASUAL', 'EARNED', 'MATERNITY', 'PATERNITY', 'BEREAVEMENT', 'UNPAID', 'COMPENSATORY'])
    .withMessage('Invalid leave type'),
  body('start_date').isISO8601().withMessage('Start date must be a valid date'),
  body('end_date').isISO8601().withMessage('End date must be a valid date')
    .custom((value, { req }) => {
      if (new Date(value) < new Date(req.body.start_date)) {
        throw new Error('End date must be after start date');
      }
      return true;
    }),
  body('reason').notEmpty().withMessage('Reason is required'),
  body('emergency_contact').optional().matches(/^[+]?[\d\s-()]+$/).withMessage('Invalid emergency contact number')
];

// Export Report Validation
export const exportReportValidation = [
  query('report_type').isIn(['attendance', 'performance', 'leave', 'payroll'])
    .withMessage('Invalid report type'),
  query('department').optional().notEmpty().withMessage('Department cannot be empty'),
  query('start_date').optional().matches(/^\d{2}-\d{2}-\d{4}$/).withMessage('Start date must be in DD-MM-YYYY format'),
  query('end_date').optional().matches(/^\d{2}-\d{2}-\d{4}$/).withMessage('End date must be in DD-MM-YYYY format')
    .custom((value, { req }) => {
      if (req.query.start_date && value) {
        const start = new Date(req.query.start_date.split('-').reverse().join('-'));
        const end = new Date(value.split('-').reverse().join('-'));
        if (end < start) {
          throw new Error('End date must be after start date');
        }
      }
      return true;
    }),
  query('format').optional().isIn(['csv', 'json']).withMessage('Format must be csv or json')
];
