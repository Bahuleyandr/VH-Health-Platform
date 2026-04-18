import { body, param, query } from 'express-validator';

export const markAttendanceValidation = [
  body('staff_id').isInt({ min: 1 }).withMessage('Valid staff ID required'),
  body('check_in_time').optional().isISO8601().withMessage('Valid check-in time required'),
  body('check_out_time').optional().isISO8601().withMessage('Valid check-out time required'),
  body('location').optional().isObject().withMessage('Location must be an object'),
  body('break_duration_minutes').optional().isInt({ min: 0 }).withMessage('Valid break duration required')
];

export const getAttendanceValidation = [
  param('id').isInt({ min: 1 }).withMessage('Valid staff ID required'),
  query('days').optional().isInt({ min: 1, max: 365 }).withMessage('Valid days range required (1-365)'),
  query('start_date').optional().isISO8601().withMessage('Valid start date required'),
  query('end_date').optional().isISO8601().withMessage('Valid end date required')
];